/**
 * ConfigService — Effect Service
 *
 * Reads and resolves `laborer.json` config files using a layered resolution
 * strategy. Config values merge with closest-to-project-root winning. Each
 * resolved value carries provenance metadata (the file path it came from,
 * or "default").
 *
 * Resolution order:
 * 1. `laborer.json` at the project root
 * 2. Walk up parent directories looking for `laborer.json` files
 * 3. Global config at `~/.config/laborer/laborer.json`
 * 4. Hardcoded defaults: `worktreeDir` = `<projectRepoPath>.worktrees`
 *
 * Config schema:
 * ```json
 * {
 *   "worktreeDir": "/path/to/my-project.worktrees",
 *   "setupScripts": ["bun install", "cp .env.example .env"],
 *   "brrrConfig": "path/to/brrr/config.toml"
 * }
 * ```
 *
 * The config file name is `laborer.json`.
 * Auto-creates `~/.config/laborer/` directory if it doesn't exist.
 *
 * Usage:
 * ```ts
 * const program = Effect.gen(function* () {
 *   const config = yield* ConfigService
 *   const resolved = yield* config.resolveConfig("/path/to/repo", "my-project")
 *   // resolved.worktreeDir.value === "/path/to/repo.worktrees"
 *   // resolved.worktreeDir.source === "default"
 * })
 * ```
 *
 * Issue #154: Config Service — resolve config with walk-up + global default
 *
 * @see PRD-global-worktree-config.md
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { AgentProvider } from '@laborer/shared/rpc'
import { Context, Data, Effect, Layer } from 'effect'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

class ConfigIOError extends Data.TaggedError('ConfigIOError')<{
  readonly message: string
  readonly cause: unknown
}> {}

class ConfigValidationError extends Data.TaggedError('ConfigValidationError')<{
  readonly message: string
}> {}

/** Config file name used at all levels (project root, ancestors, global). */
const CONFIG_FILE_NAME = 'laborer.json'

/** Global config directory under the user's home. */
const GLOBAL_CONFIG_DIR = join(homedir(), '.config', 'laborer')

/** Path to the global config file. */
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, CONFIG_FILE_NAME)

/** Module-level log annotation for structured logging. */
const logPrefix = 'ConfigService'

/** Valid sandbox provider values. */
type SandboxProviderType = 'docker' | 'daytona' | 'none'

/** All valid sandbox provider values for runtime validation. */
const VALID_SANDBOX_PROVIDERS: readonly SandboxProviderType[] = [
  'docker',
  'daytona',
  'none',
]

/** Resource limits for Daytona sandboxes. */
interface SandboxResources {
  /** CPU cores (e.g. 2). */
  readonly cpu?: number | undefined
  /** Disk size in GB (e.g. 20). */
  readonly disk?: number | undefined
  /** Memory in GB (e.g. 4). */
  readonly memory?: number | undefined
}

/**
 * Dev server sandbox configuration.
 * `image` and `dockerfile` are mutually exclusive.
 */
interface DevServerConfig {
  /** Automatically open the dev server sidebar when a workspace terminal is spawned. */
  readonly autoOpen?: boolean | undefined
  /** Minutes of inactivity before auto-stop (Daytona only, default 15). */
  readonly autoStopInterval?: number | undefined
  /** Path to a Dockerfile for building the container image. */
  readonly dockerfile?: string | undefined
  /** Base Docker image name (e.g. "node:22"). */
  readonly image?: string | undefined
  /** Override the auto-detected install command for cached deps images (e.g. "pnpm install --frozen-lockfile"). */
  readonly installCommand?: string | undefined
  /** Docker network to join (e.g. "myproject_default" for docker-compose services). When not set, uses default bridge networking. Containers can reach other Docker containers via .orb.local domains and host services via host.docker.internal. */
  readonly network?: string | undefined
  /** Port the dev server listens on inside the container. Appended to the .orb.local URL so the workspace card link works. */
  readonly port?: number | undefined
  /** Sandbox provider for this project ("docker", "daytona", or "none"). */
  readonly provider?: SandboxProviderType | undefined
  /** Daytona sandbox resource limits (CPU, memory, disk). */
  readonly resources?: SandboxResources | undefined
  /** Scripts to run inside the container before the start command (e.g. "apt-get install -y python3"). */
  readonly setupScripts?: readonly string[] | undefined
  /** Command to start the dev server (e.g. "bun dev"). */
  readonly startCommand?: string | undefined
  /** Mount point inside the container. Defaults to "/app". */
  readonly workdir?: string | undefined
}

/**
 * Valid agent provider values.
 * Each value is also the CLI command used to launch the agent.
 */
/** All valid agent provider values for runtime validation. */
const VALID_AGENT_PROVIDERS: readonly AgentProvider[] = [
  'opencode2',
  'claude',
  'codex',
]

/**
 * Shape of a `laborer.json` config file.
 * All fields are optional — missing fields are resolved from ancestor
 * configs or hardcoded defaults.
 */
interface LaborerConfig {
  /** Preferred AI coding agent. The value is also the CLI command to run. */
  readonly agent?: AgentProvider
  readonly brrrConfig?: string
  /**
   * Global default sandbox provider.
   * Per-project `devServer.provider` overrides this.
   * When neither is set, defaults to `"docker"`.
   */
  readonly defaultSandboxProvider?: SandboxProviderType
  readonly devServer?: DevServerConfig
  readonly setupScripts?: readonly string[]
  readonly watchIgnore?: readonly string[]
  readonly worktreeDir?: string
}

/** Partial updates accepted by writeProjectConfig() and writeGlobalConfig(). */
interface ProjectConfigUpdates {
  readonly agent?: AgentProvider | undefined
  readonly brrrConfig?: string | undefined
  readonly defaultSandboxProvider?: SandboxProviderType | undefined
  readonly devServer?: DevServerConfig | undefined
  readonly setupScripts?: readonly string[] | undefined
  readonly watchIgnore?: readonly string[] | undefined
  readonly worktreeDir?: string | undefined
}

/**
 * A resolved config value with provenance metadata indicating
 * which file the value came from (or "default" for hardcoded defaults).
 */
interface ResolvedValue<T> {
  /** The source file path, or "default" if using the hardcoded default. */
  readonly source: string
  /** The resolved value. */
  readonly value: T
}

/**
 * Fully resolved dev server configuration with provenance for each field.
 * All fields have concrete values (no undefined).
 */
interface ResolvedDevServerConfig {
  readonly autoOpen: ResolvedValue<boolean>
  readonly autoStopInterval: ResolvedValue<number | null>
  readonly dockerfile: ResolvedValue<string | null>
  readonly image: ResolvedValue<string | null>
  readonly installCommand: ResolvedValue<string | null>
  readonly network: ResolvedValue<string | null>
  readonly port: ResolvedValue<number | null>
  readonly provider: ResolvedValue<SandboxProviderType | null>
  readonly resources: ResolvedValue<SandboxResources | null>
  readonly setupScripts: ResolvedValue<readonly string[]>
  readonly startCommand: ResolvedValue<string | null>
  readonly workdir: ResolvedValue<string>
}

/**
 * Fully resolved config with provenance for each field.
 * All fields have concrete values (no undefined).
 */
interface ResolvedLaborerConfig {
  /** Preferred AI coding agent CLI command (defaults to "opencode2"). */
  readonly agent: ResolvedValue<AgentProvider>
  readonly brrrConfig: ResolvedValue<string | null>
  /**
   * Global default sandbox provider.
   * Resolved from the closest config that sets it; defaults to null
   * (which means "docker" when no per-project provider is set).
   */
  readonly defaultSandboxProvider: ResolvedValue<SandboxProviderType | null>
  readonly devServer: ResolvedDevServerConfig
  readonly setupScripts: ResolvedValue<readonly string[]>
  /**
   * Additional ignore patterns appended to the default set.
   * These are first-segment prefixes (e.g. ".cache", "tmp")
   * that suppress watcher events from noisy directories.
   */
  readonly watchIgnore: ResolvedValue<readonly string[]>
  /** Absolute path with `~` already expanded. */
  readonly worktreeDir: ResolvedValue<string>
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Expand `~` at the start of a path to the user's home directory.
 * Only expands a leading `~` or `~/` — tilde in the middle of a path
 * is left as-is.
 */
const expandTilde = (filePath: string): string => {
  if (filePath === '~') {
    return homedir()
  }
  if (filePath.startsWith('~/')) {
    return join(homedir(), filePath.slice(2))
  }
  return filePath
}

/**
 * Read and parse a `laborer.json` file at the given path.
 * Returns `undefined` if the file doesn't exist.
 * Returns an empty object if the file can't be read or parsed (logs a warning).
 */
const readConfigFile = (
  configPath: string
): Effect.Effect<LaborerConfig | undefined, never> =>
  Effect.gen(function* () {
    if (!existsSync(configPath)) {
      return undefined
    }

    const content = yield* Effect.try({
      try: () => readFileSync(configPath, 'utf-8'),
      catch: (cause) =>
        new ConfigIOError({
          message: `Failed to read ${configPath}`,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `${error.message}: ${String(error.cause)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          return '' as string
        })
      )
    )

    if (content.length === 0) {
      return {} as LaborerConfig
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause) =>
        new ConfigIOError({
          message: `Failed to parse ${configPath}`,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `${error.message}: ${String(error.cause)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          return {} as unknown
        })
      )
    )

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const config = parsed as Record<string, unknown>
      if (config.agent === 'opencode') {
        const migrated = { ...config, agent: 'opencode2' }
        yield* writeJsonAtomicStrict(configPath, migrated).pipe(Effect.orDie)
        yield* Effect.logInfo(
          `Migrated legacy OpenCode agent config at ${configPath} to opencode2`
        ).pipe(Effect.annotateLogs('module', logPrefix))
        return migrated as LaborerConfig
      }
      return config as LaborerConfig
    }

    yield* Effect.logWarning(
      `Expected object in ${configPath}, got ${typeof parsed}`
    ).pipe(Effect.annotateLogs('module', logPrefix))
    return {} as LaborerConfig
  })

/**
 * Read and parse a config file as a plain object.
 * Used by writeProjectConfig to preserve unknown fields during round-trip writes.
 */
const readRawConfigObject = (
  configPath: string
): Effect.Effect<Record<string, unknown> | undefined, never> =>
  Effect.gen(function* () {
    if (!existsSync(configPath)) {
      return undefined
    }

    const content = yield* Effect.try({
      try: () => readFileSync(configPath, 'utf-8'),
      catch: (cause) =>
        new ConfigIOError({
          message: `Failed to read ${configPath}`,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `${error.message}: ${String(error.cause)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          return '' as string
        })
      )
    )

    if (content.length === 0) {
      return {} as Record<string, unknown>
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(content) as unknown,
      catch: (cause) =>
        new ConfigIOError({
          message: `Failed to parse ${configPath}`,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning(
            `${error.message}: ${String(error.cause)}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
          return {} as unknown
        })
      )
    )

    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>
    }

    yield* Effect.logWarning(
      `Expected object in ${configPath}, got ${typeof parsed}`
    ).pipe(Effect.annotateLogs('module', logPrefix))
    return {} as Record<string, unknown>
  })

/**
 * Merge devServer update fields into an existing devServer config object.
 */
const mergeDevServerUpdates = (
  existing: Record<string, unknown>,
  updates: NonNullable<ProjectConfigUpdates['devServer']>
): Record<string, unknown> => {
  const merged = { ...existing }

  if (updates.autoOpen !== undefined) {
    merged.autoOpen = updates.autoOpen
  }
  if (updates.autoStopInterval !== undefined) {
    merged.autoStopInterval = updates.autoStopInterval
  }
  if (updates.image !== undefined) {
    merged.image = updates.image
  }
  if (updates.dockerfile !== undefined) {
    merged.dockerfile = updates.dockerfile
  }
  if (updates.installCommand !== undefined) {
    merged.installCommand = updates.installCommand
  }
  if (updates.network !== undefined) {
    merged.network = updates.network
  }
  if (updates.port !== undefined) {
    merged.port = updates.port
  }
  if (updates.provider !== undefined) {
    merged.provider = updates.provider
  }
  if (updates.resources !== undefined) {
    merged.resources = updates.resources
  }
  if (updates.setupScripts !== undefined) {
    merged.setupScripts = [...updates.setupScripts]
  }
  if (updates.startCommand !== undefined) {
    merged.startCommand = updates.startCommand
  }
  if (updates.workdir !== undefined) {
    merged.workdir = updates.workdir
  }

  return merged
}

/**
 * Apply explicit config updates to an existing config object.
 * Undefined fields in updates are ignored (do not overwrite existing values).
 */
const applyConfigUpdates = (
  existing: Record<string, unknown>,
  updates: ProjectConfigUpdates
): Record<string, unknown> => {
  const next: Record<string, unknown> = {
    ...existing,
    ...(existing.agent === 'opencode' ? { agent: 'opencode2' } : {}),
  }

  if (updates.agent !== undefined) {
    next.agent = updates.agent
  }

  if (updates.defaultSandboxProvider !== undefined) {
    next.defaultSandboxProvider = updates.defaultSandboxProvider
  }

  if (updates.worktreeDir !== undefined) {
    next.worktreeDir = updates.worktreeDir
  }

  if (updates.setupScripts !== undefined) {
    next.setupScripts = [...updates.setupScripts]
  }

  if (updates.brrrConfig !== undefined) {
    next.brrrConfig = updates.brrrConfig
  }

  if (updates.watchIgnore !== undefined) {
    next.watchIgnore = [...updates.watchIgnore]
  }

  if (updates.devServer !== undefined) {
    const existingDevServer =
      typeof existing.devServer === 'object' &&
      existing.devServer !== null &&
      !Array.isArray(existing.devServer)
        ? (existing.devServer as Record<string, unknown>)
        : {}
    next.devServer = mergeDevServerUpdates(existingDevServer, updates.devServer)
  }

  return next
}

/**
 * Atomically write JSON to a path by writing a temp file and renaming.
 */
const writeJsonAtomicStrict = (
  targetPath: string,
  content: Record<string, unknown>
): Effect.Effect<void, ConfigIOError> =>
  Effect.gen(function* () {
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    yield* Effect.try({
      try: () =>
        writeFileSync(`${tempPath}`, `${JSON.stringify(content, null, 2)}\n`, {
          encoding: 'utf-8',
        }),
      catch: (cause) =>
        new ConfigIOError({
          message: `Failed to write temp config file ${tempPath}`,
          cause,
        }),
    })

    yield* Effect.try({
      try: () => renameSync(tempPath, targetPath),
      catch: (cause) =>
        new ConfigIOError({
          message: `Failed to atomically move ${tempPath} to ${targetPath}`,
          cause,
        }),
    })
  })

const writeJsonAtomic = (
  targetPath: string,
  content: Record<string, unknown>
): Effect.Effect<void, never> =>
  writeJsonAtomicStrict(targetPath, content).pipe(
    Effect.catchAll((error) =>
      Effect.logWarning(`${error.message}: ${String(error.cause)}`).pipe(
        Effect.annotateLogs('module', logPrefix)
      )
    )
  )

/**
 * Walk up from a starting directory, collecting all `laborer.json` files
 * found along the way. Returns an array of `{ config, path }` tuples,
 * ordered from closest to root (project root first, ancestors after).
 *
 * Stops at the filesystem root. Does NOT include the global config.
 */
const walkUpForConfigs = (
  startDir: string
): Effect.Effect<ReadonlyArray<{ config: LaborerConfig; path: string }>> =>
  Effect.gen(function* () {
    const results: Array<{ config: LaborerConfig; path: string }> = []
    let currentDir = resolve(startDir)
    const root = resolve('/')

    while (currentDir !== root) {
      const configPath = join(currentDir, CONFIG_FILE_NAME)
      const config = yield* readConfigFile(configPath)

      if (config !== undefined) {
        results.push({ config, path: configPath })
      }

      const parentDir = dirname(currentDir)
      // Stop if we can't go higher (e.g., already at root)
      if (parentDir === currentDir) {
        break
      }
      currentDir = parentDir
    }

    return results
  })

/**
 * Ensure the global config directory exists.
 * Creates `~/.config/laborer/` recursively if it doesn't exist.
 */
const ensureGlobalConfigDir = (): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (!existsSync(GLOBAL_CONFIG_DIR)) {
      yield* Effect.try({
        try: () => mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true }),
        catch: (cause) =>
          new ConfigIOError({
            message: `Failed to create global config directory ${GLOBAL_CONFIG_DIR}`,
            cause,
          }),
      }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(`${error.message}: ${String(error.cause)}`).pipe(
            Effect.annotateLogs('module', logPrefix)
          )
        )
      )
    }
  })

/**
 * Merge config layers to produce the fully resolved config with provenance.
 *
 * @param configLayers - Array of { config, path } tuples, ordered from
 *   closest (project root) to farthest (global). Closest wins.
 * @param projectName - Used to compute the default worktreeDir.
 */
/**
 * Resolve devServer config from layered configs.
 * Iterates from farthest to closest (closest wins).
 */
const mergeDevServerConfig = (
  configLayers: ReadonlyArray<{ config: LaborerConfig; path: string }>
): ResolvedDevServerConfig => {
  let autoOpen: ResolvedValue<boolean> = {
    value: false,
    source: 'default',
  }
  let autoStopInterval: ResolvedValue<number | null> = {
    value: null,
    source: 'default',
  }
  let image: ResolvedValue<string | null> = {
    value: 'node:lts',
    source: 'default',
  }
  let dockerfile: ResolvedValue<string | null> = {
    value: null,
    source: 'default',
  }
  let installCommand: ResolvedValue<string | null> = {
    value: null,
    source: 'default',
  }
  let setupScripts: ResolvedValue<readonly string[]> = {
    value: ['corepack enable', 'pnpm install --force', 'exec bash'],
    source: 'default',
  }
  let network: ResolvedValue<string | null> = {
    value: null,
    source: 'default',
  }
  let port: ResolvedValue<number | null> = {
    value: null,
    source: 'default',
  }
  let provider: ResolvedValue<SandboxProviderType | null> = {
    value: null,
    source: 'default',
  }
  let resources: ResolvedValue<SandboxResources | null> = {
    value: null,
    source: 'default',
  }
  let startCommand: ResolvedValue<string | null> = {
    value: null,
    source: 'default',
  }
  let workdir: ResolvedValue<string> = {
    value: '/app',
    source: 'default',
  }

  const applyImage = (value: string, path: string) => {
    image = { value, source: path }
    if (dockerfile.source === path) {
      return
    }
    dockerfile = { value: null, source: 'default' }
  }

  const applyDockerfile = (value: string, path: string) => {
    dockerfile = { value, source: path }
    if (image.source === path) {
      return
    }
    image = { value: null, source: 'default' }
  }

  const applyOptionalField = <T>(
    value: T | undefined,
    apply: (resolvedValue: T) => void
  ) => {
    if (value !== undefined) {
      apply(value)
    }
  }

  const applyDevServerLayer = (ds: DevServerConfig, path: string) => {
    applyOptionalField(ds.autoOpen, (value) => {
      autoOpen = { value, source: path }
    })
    applyOptionalField(ds.autoStopInterval, (value) => {
      autoStopInterval = { value, source: path }
    })
    applyOptionalField(ds.image, (value) => applyImage(value, path))
    applyOptionalField(ds.dockerfile, (value) => applyDockerfile(value, path))
    applyOptionalField(ds.installCommand, (value) => {
      installCommand = { value, source: path }
    })
    applyOptionalField(ds.network, (value) => {
      network = { value, source: path }
    })
    applyOptionalField(ds.port, (value) => {
      port = { value, source: path }
    })
    applyOptionalField(ds.provider, (value) => {
      provider = { value, source: path }
    })
    applyOptionalField(ds.resources, (value) => {
      resources = { value, source: path }
    })
    applyOptionalField(ds.setupScripts, (value) => {
      setupScripts = { value, source: path }
    })
    applyOptionalField(ds.startCommand, (value) => {
      startCommand = { value, source: path }
    })
    applyOptionalField(ds.workdir, (value) => {
      workdir = { value, source: path }
    })
  }

  for (let i = configLayers.length - 1; i >= 0; i--) {
    const layer = configLayers[i]
    if (layer === undefined) {
      continue
    }
    const { config, path } = layer

    if (config.devServer !== undefined) {
      applyDevServerLayer(config.devServer, path)
    }
  }

  return {
    autoOpen,
    autoStopInterval,
    dockerfile,
    image,
    installCommand,
    network,
    port,
    provider,
    resources,
    setupScripts,
    startCommand,
    workdir,
  }
}

/**
 * Validate that the resolved devServer config is consistent.
 * Returns an error message string if validation fails, or undefined if valid.
 */
const validateDevServerConfig = (
  devServer: ResolvedDevServerConfig
): string | undefined => {
  if (devServer.image.value !== null && devServer.dockerfile.value !== null) {
    return (
      'devServer.image and devServer.dockerfile are mutually exclusive. ' +
      `image from ${devServer.image.source}, dockerfile from ${devServer.dockerfile.source}`
    )
  }
  if (
    devServer.provider.value !== null &&
    !VALID_SANDBOX_PROVIDERS.includes(devServer.provider.value)
  ) {
    return `devServer.provider must be "docker", "daytona", or "none", got "${String(devServer.provider.value)}" from ${devServer.provider.source}`
  }
  return undefined
}

/**
 * Apply the global defaultSandboxProvider fallback to devServer.provider:
 * If no per-project devServer.provider is set, fall back to the global
 * defaultSandboxProvider. If that is also null, the effective provider
 * remains null (which downstream code treats as "docker").
 */
const applyProviderFallback = (
  devServer: ResolvedDevServerConfig,
  defaultSandboxProvider: ResolvedValue<SandboxProviderType | null>
): ResolvedDevServerConfig =>
  devServer.provider.value === null && defaultSandboxProvider.value !== null
    ? {
        ...devServer,
        provider: {
          value: defaultSandboxProvider.value,
          source: defaultSandboxProvider.source,
        },
      }
    : devServer

const mergeConfigs = (
  configLayers: ReadonlyArray<{ config: LaborerConfig; path: string }>,
  _projectName: string,
  projectRepoPath: string
): ResolvedLaborerConfig => {
  const defaultWorktreeDir = `${projectRepoPath}.worktrees`

  let agent: ResolvedValue<AgentProvider> = {
    value: 'opencode2',
    source: 'default',
  }
  let worktreeDir: ResolvedValue<string> = {
    value: defaultWorktreeDir,
    source: 'default',
  }
  let setupScripts: ResolvedValue<readonly string[]> = {
    value: [],
    source: 'default',
  }
  let brrrConfig: ResolvedValue<string | null> = {
    value: null,
    source: 'default',
  }
  let watchIgnore: ResolvedValue<readonly string[]> = {
    value: [],
    source: 'default',
  }
  let defaultSandboxProvider: ResolvedValue<SandboxProviderType | null> = {
    value: null,
    source: 'default',
  }

  // Walk from farthest to closest (global -> ancestors -> project root).
  // Closest wins, so we iterate in reverse and each closer layer overwrites.
  for (let i = configLayers.length - 1; i >= 0; i--) {
    const layer = configLayers[i]
    if (layer === undefined) {
      continue
    }
    const { config, path } = layer

    if (config.agent !== undefined) {
      agent = {
        value: config.agent,
        source: path,
      }
    }

    if (config.worktreeDir !== undefined) {
      worktreeDir = {
        value: resolve(expandTilde(config.worktreeDir)),
        source: path,
      }
    }

    if (config.setupScripts !== undefined) {
      setupScripts = {
        value: config.setupScripts,
        source: path,
      }
    }

    if (config.brrrConfig !== undefined) {
      brrrConfig = {
        value: config.brrrConfig,
        source: path,
      }
    }

    if (config.watchIgnore !== undefined) {
      watchIgnore = {
        value: config.watchIgnore,
        source: path,
      }
    }

    if (config.defaultSandboxProvider !== undefined) {
      defaultSandboxProvider = {
        value: config.defaultSandboxProvider,
        source: path,
      }
    }
  }

  const devServer = mergeDevServerConfig(configLayers)

  return {
    agent,
    defaultSandboxProvider,
    devServer: applyProviderFallback(devServer, defaultSandboxProvider),
    worktreeDir,
    setupScripts,
    brrrConfig,
    watchIgnore,
  }
}

// ---------------------------------------------------------------------------
// ConfigService — Effect Tagged Service
// ---------------------------------------------------------------------------

/**
 * ConfigService Effect Context Tag
 *
 * Provides config resolution and reading for project and global configs.
 * Stateless service — reads files on each call (no caching).
 */
class ConfigService extends Context.Tag('@laborer/ConfigService')<
  ConfigService,
  {
    /**
     * Resolve the full config for a project by walking up from the project
     * root and merging with the global config and hardcoded defaults.
     *
     * @param projectRepoPath - Absolute path to the project's git repo root
     * @param projectName - Project name (used for default worktreeDir)
     */
    readonly resolveConfig: (
      projectRepoPath: string,
      projectName: string
    ) => Effect.Effect<ResolvedLaborerConfig, ConfigValidationError>

    /**
     * Read the global config at `~/.config/laborer/laborer.json`.
     * Creates the directory if it doesn't exist.
     * Returns an empty config if the file doesn't exist or is invalid.
     */
    readonly readGlobalConfig: () => Effect.Effect<LaborerConfig, never>

    /**
     * Write project-level config updates to `<projectRepoPath>/laborer.json`.
     * Merges partial updates with existing file content, preserves unknown
     * fields, and uses an atomic temp-file + rename write strategy.
     */
    readonly writeProjectConfig: (
      projectRepoPath: string,
      updates: ProjectConfigUpdates
    ) => Effect.Effect<void, never>

    /**
     * Write global config updates to `~/.config/laborer/laborer.json`.
     * Merges partial updates with existing file content, preserves unknown
     * fields, and uses an atomic temp-file + rename write strategy.
     */
    readonly writeGlobalConfig: (
      updates: ProjectConfigUpdates
    ) => Effect.Effect<void, never>
  }
>() {
  static readonly layer = Layer.succeed(
    ConfigService,
    ConfigService.of({
      resolveConfig: Effect.fn('ConfigService.resolveConfig')(function* (
        projectRepoPath: string,
        projectName: string
      ) {
        // 1. Ensure the global config dir exists
        yield* ensureGlobalConfigDir()

        // 2. Walk up from project root to collect local/ancestor configs
        const localConfigs = yield* walkUpForConfigs(projectRepoPath)

        // 3. Read the global config
        const globalConfig = yield* readConfigFile(GLOBAL_CONFIG_PATH)

        // 4. Build the full layer list: local configs + global config
        const allLayers =
          globalConfig !== undefined
            ? [
                ...localConfigs,
                { config: globalConfig, path: GLOBAL_CONFIG_PATH },
              ]
            : [...localConfigs]

        // 5. Merge with closest-wins strategy and apply defaults
        const resolved = mergeConfigs(allLayers, projectName, projectRepoPath)

        // 6. Validate devServer mutual exclusion (image vs dockerfile)
        const validationError = validateDevServerConfig(resolved.devServer)
        if (validationError !== undefined) {
          return yield* new ConfigValidationError({
            message: validationError,
          })
        }

        yield* Effect.logDebug(
          `Resolved config for "${projectName}": agent="${resolved.agent.value}" (from ${resolved.agent.source}), worktreeDir="${resolved.worktreeDir.value}" (from ${resolved.worktreeDir.source}), setupScripts=${resolved.setupScripts.value.length} (from ${resolved.setupScripts.source}), brrrConfig=${resolved.brrrConfig.value ?? 'null'} (from ${resolved.brrrConfig.source}), devServer.image=${resolved.devServer.image.value ?? 'null'} (from ${resolved.devServer.image.source}), devServer.workdir="${resolved.devServer.workdir.value}" (from ${resolved.devServer.workdir.source})`
        ).pipe(Effect.annotateLogs('module', logPrefix))

        return resolved
      }),

      readGlobalConfig: Effect.fn('ConfigService.readGlobalConfig')(
        function* () {
          yield* ensureGlobalConfigDir()

          const config = yield* readConfigFile(GLOBAL_CONFIG_PATH)

          return config ?? ({} as LaborerConfig)
        }
      ),

      writeProjectConfig: Effect.fn('ConfigService.writeProjectConfig')(
        function* (projectRepoPath: string, updates: ProjectConfigUpdates) {
          const projectConfigPath = join(
            resolve(projectRepoPath),
            CONFIG_FILE_NAME
          )

          const existing =
            (yield* readRawConfigObject(projectConfigPath)) ??
            ({} as Record<string, unknown>)
          const next = applyConfigUpdates(existing, updates)

          yield* writeJsonAtomic(projectConfigPath, next)

          yield* Effect.logDebug(
            `Wrote project config at ${projectConfigPath}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      ),

      writeGlobalConfig: Effect.fn('ConfigService.writeGlobalConfig')(
        function* (updates: ProjectConfigUpdates) {
          yield* ensureGlobalConfigDir()

          const existing =
            (yield* readRawConfigObject(GLOBAL_CONFIG_PATH)) ??
            ({} as Record<string, unknown>)
          const next = applyConfigUpdates(existing, updates)

          yield* writeJsonAtomic(GLOBAL_CONFIG_PATH, next)

          yield* Effect.logDebug(
            `Wrote global config at ${GLOBAL_CONFIG_PATH}`
          ).pipe(Effect.annotateLogs('module', logPrefix))
        }
      ),
    })
  )
}

export {
  ConfigService,
  ConfigValidationError,
  VALID_AGENT_PROVIDERS,
  VALID_SANDBOX_PROVIDERS,
  // Exported for testing
  CONFIG_FILE_NAME,
  expandTilde,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_PATH,
  mergeConfigs,
  mergeDevServerConfig,
  readConfigFile,
  readRawConfigObject,
  validateDevServerConfig,
  walkUpForConfigs,
  applyConfigUpdates,
  writeJsonAtomic,
}

export type {
  DevServerConfig,
  LaborerConfig,
  ProjectConfigUpdates,
  ResolvedDevServerConfig,
  ResolvedLaborerConfig,
  ResolvedValue,
  SandboxProviderType,
  SandboxResources,
}
