import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type RuntimeModuleLoader = () => Record<string, unknown> | Promise<Record<string, unknown>>

const runtimeModulesKey = Symbol.for("opencode.plugin.runtime-modules")
const runtimeInstalledKey = Symbol.for("opencode.plugin.runtime-installed")

type GlobalState = typeof globalThis & {
  [runtimeModulesKey]?: Readonly<Record<string, RuntimeModuleLoader>>
  [runtimeInstalledKey]?: boolean
}

export function discoverPluginRuntimeSpecifiers(from = import.meta.dir): ReadonlyArray<readonly [string, string]> {
  return [...discoverPackageSpecifiers("effect", from), ...discoverPackageSpecifiers("@opencode/plugin", from)]
}

export function pluginRuntimeModules(): Readonly<Record<string, RuntimeModuleLoader>> {
  if (typeof Bun === "undefined") return {}
  const state = globalThis as GlobalState
  if (state[runtimeModulesKey]) return state[runtimeModulesKey]
  const modules = Object.fromEntries(
    discoverPluginRuntimeSpecifiers().map(([specifier, resolved]) => [specifier, createLoader(resolved)]),
  )
  state[runtimeModulesKey] = modules
  return modules
}

export function ensurePluginRuntime() {
  if (typeof Bun === "undefined") return {}
  const state = globalThis as GlobalState
  const modules = pluginRuntimeModules()
  if (state[runtimeInstalledKey]) return modules
  state[runtimeInstalledKey] = true
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

function discoverPackageSpecifiers(pkgName: string, from: string): ReadonlyArray<readonly [string, string]> {
  const pkgPath = Bun.resolveSync(`${pkgName}/package.json`, from)
  const dir = realpathSync(path.dirname(pkgPath))
  const [subdir, ext] = existsSync(path.join(dir, "dist")) ? ["dist", ".js"] : ["src", ".ts"]
  const scanDir = path.join(dir, subdir)
  const entries = new Map<string, string>([[pkgName, Bun.resolveSync(pkgName, from)]])
  for (const file of new Bun.Glob(`**/*${ext}`).scanSync({ cwd: scanDir })) {
    const normalized = file.replaceAll("\\", "/")
    if (normalized.startsWith("internal/") || normalized.includes("/internal/") || normalized.startsWith("source.")) {
      continue
    }
    const base = normalized.slice(0, -ext.length)
    const candidates = base.endsWith("/index")
      ? [`${pkgName}/${base.slice(0, -"/index".length)}`, `${pkgName}/${base}`]
      : [`${pkgName}/${base}`]
    for (const specifier of candidates) {
      if (specifier === `${pkgName}/`) continue
      try {
        entries.set(specifier, Bun.resolveSync(specifier, from))
      } catch {}
    }
  }
  return [...entries.entries()].toSorted(([left], [right]) => left.localeCompare(right))
}

function createForeignPackageFilter() {
  const roots = new Set<string>()
  for (const pkgName of ["effect", "@opencode/plugin"]) {
    try {
      const dir = path.dirname(Bun.resolveSync(`${pkgName}/package.json`, import.meta.dir))
      roots.add(dir)
      roots.add(realpathSync(dir))
    } catch {}
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const suffix = String.raw`[/\\]node_modules[/\\](?:effect|@opencode[/\\]plugin)[/\\].*\.[cm]?[jt]sx?(?:[?#].*)?$`
  if (roots.size === 0) return new RegExp(suffix)
  return new RegExp(`^(?!(?:${[...roots].map(escape).join("|")})[/\\\\]).*${suffix}`)
}

function formatForeignPackageError(filePath: string) {
  const match = filePath.replaceAll("\\", "/").match(/\/node_modules\/((?:@opencode\/plugin|effect)\/.+)$/)
  const target = match ? match[1] : filePath
  return new Error(
    `Cannot load "${target}" from plugin node_modules: "${target}" is not provided by OpenCode; plugins must use the host's "effect" and "@opencode/plugin" modules.`,
  )
}
