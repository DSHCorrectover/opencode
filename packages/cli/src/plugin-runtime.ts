import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

type RuntimeModuleLoader = () => Record<string, unknown> | Promise<Record<string, unknown>>

const runtimeModulesKey = Symbol.for("opencode.plugin.runtime-modules")

type GlobalState = typeof globalThis & {
  [runtimeModulesKey]?: Readonly<Record<string, RuntimeModuleLoader>>
}

export function discoverPluginRuntimeSpecifiers(): ReadonlyMap<string, string> {
  const entries = new Map<string, string>()
  for (const pkgName of ["effect", "@opencode/plugin"]) {
    const dir = realpathSync(path.dirname(Bun.resolveSync(`${pkgName}/package.json`, import.meta.dir)))
    const [subdir, ext] = existsSync(path.join(dir, "dist")) ? ["dist", ".js"] : ["src", ".ts"]
    const scanDir = path.join(dir, subdir)
    entries.set(pkgName, Bun.resolveSync(pkgName, import.meta.dir))
    for (const file of new Bun.Glob(`**/*${ext}`).scanSync({ cwd: scanDir })) {
      const normalized = file.replaceAll("\\", "/")
      if (normalized.startsWith("internal/") || normalized.includes("/internal/") || normalized.startsWith("source.")) {
        continue
      }
      const base = normalized.slice(0, -ext.length)
      if (base === "index") continue
      if (!base.endsWith("/index")) {
        entries.set(`${pkgName}/${base}`, path.join(scanDir, file))
        continue
      }
      for (const specifier of [`${pkgName}/${base.slice(0, -"/index".length)}`, `${pkgName}/${base}`]) {
        try {
          entries.set(specifier, Bun.resolveSync(specifier, import.meta.dir))
        } catch {}
      }
    }
  }
  return entries
}

export function ensurePluginRuntime(): Readonly<Record<string, RuntimeModuleLoader>> {
  if (typeof Bun === "undefined") return {}
  const state = globalThis as GlobalState
  if (state[runtimeModulesKey]) return state[runtimeModulesKey]
  const modules = Object.fromEntries(
    [...discoverPluginRuntimeSpecifiers().entries()].map(([specifier, resolved]) => [specifier, createLoader(resolved)]),
  )
  state[runtimeModulesKey] = modules
  const foreignFilter = createForeignPackageFilter()
  Bun.plugin({
    name: "opencode-plugin-runtime",
    setup(build) {
      for (const [specifier, load] of Object.entries(modules)) {
        build.module(specifier, () => {
          const exports = load()
          if (exports instanceof Promise) {
            return exports.then((value) => ({ exports: value, loader: "object" as const }))
          }
          return { exports, loader: "object" }
        })
      }
      build.onLoad({ filter: foreignFilter }, (args) => {
        throw formatForeignPackageError(args.path)
      })
    },
  })
  return modules
}

function createLoader(resolved: string): RuntimeModuleLoader {
  let cached: Record<string, unknown> | undefined
  return () => {
    if (cached) return cached
    try {
      cached = require(resolved) as Record<string, unknown>
      return cached
    } catch {
      return import(pathToFileURL(resolved).href).then((mod: Record<string, unknown>) => {
        cached = mod
        return mod
      })
    }
  }
}

function createForeignPackageFilter() {
  const roots = new Set<string>()
  for (const pkgName of ["effect", "@opencode/plugin"]) {
    const dir = path.dirname(Bun.resolveSync(`${pkgName}/package.json`, import.meta.dir))
    roots.add(dir)
    roots.add(realpathSync(dir))
  }
  const escaped = [...roots].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return new RegExp(
    `^(?!(?:${escaped})[/\\\\]).*[/\\\\]node_modules[/\\\\](?:effect|@opencode[/\\\\]plugin)[/\\\\].*\\.[cm]?[jt]sx?(?:[?#].*)?$`,
  )
}

function formatForeignPackageError(filePath: string) {
  const match = filePath.replaceAll("\\", "/").match(/\/node_modules\/((?:@opencode\/plugin|effect)\/.+)$/)
  const target = match ? match[1] : filePath
  return new Error(
    `Cannot load "${target}" from plugin node_modules: "${target}" is not provided by OpenCode; plugins must use the host's "effect" and "@opencode/plugin" modules.`,
  )
}
