import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

type RuntimeModuleLoader = () => Record<string, unknown> | Promise<Record<string, unknown>>

const runtimeModulesKey = Symbol.for("opencode.plugin.runtime-modules")
const prebundledModules: Readonly<Record<string, RuntimeModuleLoader>> | undefined = undefined

type GlobalState = typeof globalThis & {
  [runtimeModulesKey]?: Readonly<Record<string, RuntimeModuleLoader>>
}

export function discoverPluginRuntimeSpecifiers(
  from = import.meta.dir,
  packages: readonly string[] = ["effect", "@opencode/plugin"],
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>()
  for (const pkgName of packages) {
    const realDir = path.dirname(Bun.resolveSync(`${pkgName}/package.json`, from))
    const loadDir = findNodeModulesDir(pkgName, from, realDir)
    const toLoadPath = (resolved: string) =>
      loadDir === realDir ? resolved : path.join(loadDir, path.relative(realDir, resolved))
    const rootEntry = Bun.resolveSync(pkgName, from)
    const relParts = path.relative(realDir, rootEntry).replaceAll("\\", "/").split("/")
    const scanDir = relParts.length > 1 ? path.join(realDir, relParts[0]) : realDir
    const ext = path.extname(rootEntry) || ".js"
    entries.set(pkgName, toLoadPath(rootEntry))
    for (const file of new Bun.Glob(`**/*${ext}`).scanSync({ cwd: scanDir })) {
      const normalized = file.replaceAll("\\", "/")
      if (normalized.startsWith("internal/") || normalized.includes("/internal/") || normalized.startsWith("source.")) {
        continue
      }
      const base = normalized.slice(0, -ext.length)
      if (base === "index") continue
      const candidates = base.endsWith("/index")
        ? [`${pkgName}/${base.slice(0, -"/index".length)}`, `${pkgName}/${base}`]
        : [`${pkgName}/${base}`]
      for (const specifier of candidates) {
        try {
          entries.set(specifier, toLoadPath(Bun.resolveSync(specifier, from)))
        } catch {}
      }
    }
  }
  return entries
}

export function pluginRuntimeLoaderCode(specifier: string, entries: ReadonlyMap<string, string>) {
  if (specifier.startsWith("effect/")) {
    const slash = specifier.lastIndexOf("/")
    const parent = specifier.slice(0, slash)
    const member = specifier.slice(slash + 1)
    const parentResolved = entries.get(parent)
    const resolved = entries.get(specifier)
    if (
      member !== "index" &&
      parentResolved &&
      resolved &&
      (require(parentResolved) as Record<string, unknown>)[member] === require(resolved)
    ) {
      return `() => require(${JSON.stringify(parent)})[${JSON.stringify(member)}]`
    }
  }
  return `() => require(${JSON.stringify(specifier)})`
}

export function ensurePluginRuntime() {
  if (typeof Bun === "undefined") return {}
  const state = globalThis as GlobalState
  if (state[runtimeModulesKey]) return state[runtimeModulesKey]
  const modules =
    prebundledModules ??
    (() => {
      const entries = discoverPluginRuntimeSpecifiers()
      const effectEntry = entries.get("effect")
      if (effectEntry) require(effectEntry)
      return Object.fromEntries(
        [...entries.entries()].map(([specifier, resolved]) => [specifier, createLoader(resolved)]),
      )
    })()
  state[runtimeModulesKey] = modules
  const foreignFilter = createForeignPackageFilter()
  const hostPluginDir = prebundledModules
    ? undefined
    : path.dirname(Bun.resolveSync("@opencode/plugin/package.json", import.meta.dir))
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
      // Temporary until OpenTUI preserves host specifiers (anomalyco/opentui#1569).
      build.onResolve({ filter: /^(?:file:\/\/|\/|[A-Za-z]:[/\\])/ }, (args) => {
        if (!args.importer || args.importer === import.meta.path) return undefined
        const matched = resolveRewrittenHostSpecifier(args.path, modules, hostPluginDir)
        return matched ? { path: matched } : undefined
      })
      build.onLoad({ filter: foreignFilter }, (args) => {
        const match = args.path.replaceAll("\\", "/").match(/\/node_modules\/((?:@opencode\/plugin|effect)\/.+)$/)
        const target = match ? match[1] : args.path
        throw new Error(
          `Cannot load "${target}" from plugin node_modules: "${target}" is not provided by OpenCode; plugins must use the host's "effect" and "@opencode/plugin" modules.`,
        )
      })
    },
  })
  return modules
}

export function createLoader(resolved: string): RuntimeModuleLoader {
  let cached: Record<string, unknown> | undefined
  let pending: Promise<Record<string, unknown>> | undefined
  return () => {
    if (cached) return cached
    if (pending) return pending
    try {
      return (cached = require(resolved) as Record<string, unknown>)
    } catch {
      return (pending = import(pathToFileURL(resolved).href).then(
        (mod: Record<string, unknown>) => (cached = mod),
        (error) => {
          pending = undefined
          throw error
        },
      ))
    }
  }
}

export function createForeignPackageFilter(rootsInput?: Iterable<string>) {
  const suffix = String.raw`[/\\]node_modules[/\\](?:effect|@opencode[/\\]plugin)[/\\].*\.[cm]?[jt]sx?(?:[?#].*)?$`
  if (prebundledModules && !rootsInput) return new RegExp(suffix)
  const roots = new Set<string>(rootsInput)
  if (!rootsInput) {
    for (const pkgName of ["effect", "@opencode/plugin"]) {
      const dir = path.dirname(Bun.resolveSync(`${pkgName}/package.json`, import.meta.dir))
      roots.add(dir)
      roots.add(findNodeModulesDir(pkgName, import.meta.dir, dir))
    }
  }
  const escaped = [...roots]
    .map((value) =>
      value
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/(?:\\\/|\\\\|\/)+/g, "[/\\\\]"),
    )
    .join("|")
  return new RegExp(`^(?!(?:${escaped})[/\\\\]).*${suffix}`)
}

function findNodeModulesDir(pkgName: string, from: string, realDir: string) {
  if (/[/\\]node_modules[/\\]/.test(realDir)) return realDir
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", pkgName)
    if (existsSync(candidate) && realpathSync(candidate) === realDir) return candidate
    if (path.dirname(dir) === dir) return realDir
  }
}

function resolveRewrittenHostSpecifier(
  specifier: string,
  modules: Readonly<Record<string, unknown>>,
  hostPluginDir?: string,
) {
  const targetPath = specifier.startsWith("file://") ? fileURLToPath(specifier) : specifier
  const match = targetPath.match(/^(.*)[/\\]node_modules[/\\](@opencode[/\\]plugin|effect)[/\\](.+)$/)
  const rel = !match && hostPluginDir ? path.relative(hostPluginDir, targetPath) : undefined
  if (!match && (!rel || rel.startsWith("..") || path.isAbsolute(rel))) return undefined
  if (!existsSync(targetPath)) return undefined
  const ownerDir = match ? match[1] || "/" : import.meta.dir
  const pkgName = match ? match[2].replaceAll("\\", "/") : "@opencode/plugin"
  const rawSubpath = match ? match[3] : rel!
  const targetReal = realpathSync(targetPath)
  const base = rawSubpath
    .replaceAll("\\", "/")
    .replace(/^(?:dist(?:\/(?:esm|cjs))?|src)\//, "")
    .replace(/\.[cm]?[jt]sx?(?:[?#].*)?$/, "")
  const candidates = base.endsWith("/index")
    ? [pkgName, `${pkgName}/${base.slice(0, -"/index".length)}`, `${pkgName}/${base}`]
    : [pkgName, `${pkgName}/${base}`]
  return candidates.find((candidate) => {
    if (!(candidate in modules)) return false
    try {
      return Bun.resolveSync(candidate, ownerDir) === targetReal
    } catch {
      return false
    }
  })
}
