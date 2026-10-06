import { existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

type RuntimeModuleLoader = () => Record<string, unknown> | Promise<Record<string, unknown>>

const runtimeModulesKey = Symbol.for("opencode.plugin.runtime-modules")
const runtimePackages = ["effect", "@opencode/plugin"] as const
const nodeModulesPkgPattern = /^(.*)[/\\]node_modules[/\\](@opencode[/\\]plugin|effect)[/\\](.+)$/
const prebundledModules: Readonly<Record<string, RuntimeModuleLoader>> | undefined = undefined

type GlobalState = typeof globalThis & {
  [runtimeModulesKey]?: Readonly<Record<string, RuntimeModuleLoader>>
}

export function discoverPluginRuntimeSpecifiers(
  from = import.meta.dir,
  packages: readonly string[] = runtimePackages,
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
      for (const specifier of specifierCandidates(pkgName, normalized)) {
        if (entries.has(specifier)) continue
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
  const hostPluginDir = prebundledModules
    ? undefined
    : path.dirname(Bun.resolveSync("@opencode/plugin/package.json", import.meta.dir))
  Bun.plugin({
    name: "opencode-plugin-runtime",
    setup(build) {
      for (const [specifier, load] of Object.entries(modules)) {
        build.module(specifier, () => {
          const exports = load()
          return exports instanceof Promise
            ? exports.then((value) => ({ exports: value, loader: "object" as const }))
            : { exports, loader: "object" as const }
        })
      }
      // Temporary until OpenTUI preserves host specifiers (anomalyco/opentui#1569).
      build.onResolve({ filter: /^(?:file:\/\/|\/|[A-Za-z]:[/\\])/ }, (args) => {
        if (!args.importer || args.importer === import.meta.path) return undefined
        const matched = resolveRewrittenHostSpecifier(args.path, modules, hostPluginDir)
        return matched ? { path: matched } : undefined
      })
      build.onLoad({ filter: createForeignPackageFilter() }, (args) => {
        const match = args.path.match(nodeModulesPkgPattern)
        const target = match ? `${match[2]}/${match[3]}`.replaceAll("\\", "/") : args.path
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
  const roots = new Set<string>(
    rootsInput ??
      runtimePackages.flatMap((pkgName) => {
        const dir = path.dirname(Bun.resolveSync(`${pkgName}/package.json`, import.meta.dir))
        return [dir, findNodeModulesDir(pkgName, import.meta.dir, dir)]
      }),
  )
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

function specifierCandidates(pkgName: string, subpath: string) {
  const base = subpath
    .replaceAll("\\", "/")
    .replace(/^(?:dist(?:\/(?:esm|cjs))?|src)\//, "")
    .replace(/\.[cm]?[jt]sx?(?:[?#].*)?$/, "")
  if (base === "index") return [pkgName]
  return base.endsWith("/index")
    ? [`${pkgName}/${base.slice(0, -"/index".length)}`, `${pkgName}/${base}`, pkgName]
    : [`${pkgName}/${base}`, pkgName]
}

function resolveRewrittenHostSpecifier(
  specifier: string,
  modules: Readonly<Record<string, unknown>>,
  hostPluginDir?: string,
) {
  const targetPath = specifier.startsWith("file://") ? fileURLToPath(specifier) : specifier
  const match = targetPath.match(nodeModulesPkgPattern)
  const rel = !match && hostPluginDir ? path.relative(hostPluginDir, targetPath) : undefined
  if ((!match && (!rel || rel.startsWith("..") || path.isAbsolute(rel))) || !existsSync(targetPath)) return undefined
  const ownerDir = match ? match[1] || "/" : import.meta.dir
  const pkgName = match ? match[2].replaceAll("\\", "/") : "@opencode/plugin"
  const targetReal = realpathSync(targetPath)
  return specifierCandidates(pkgName, match ? match[3] : rel!).find((candidate) => {
    if (!(candidate in modules)) return false
    try {
      return Bun.resolveSync(candidate, ownerDir) === targetReal
    } catch {
      return false
    }
  })
}
