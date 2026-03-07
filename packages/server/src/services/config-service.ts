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
 * 4. Hardcoded defaults: `worktreeDir` = `~/.config/laborer/<projectName>`
 *
 * Config schema:
 * ```json
 * {
 *   "worktreeDir": "~/.config/laborer/my-project",
 *   "prdsDir": "~/.config/laborer/my-project/prds",
 *   "setupScripts": ["bun install", "cp .env.example .env"],
 *   "rlphConfig": "path/to/rlph.json"
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
 *   // resolved.worktreeDir.value === "/Users/me/.config/laborer/my-project"
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

/**
 * Dev server container configuration.
 * `image` and `dockerfile` are mutually exclusive.
 */
interface DevServerConfig {
  /** Path to a Dockerfile for building the container image. */
  readonly dockerfile?: string | undefined
  /** Base Docker image name (e.g. "node:22"). */
  readonly image?: string | undefined
  /** Scripts to run inside the container before the start command (e.g. "apt-get install -y python3"). */
  readonly setupScripts?: readonly string[] | undefined
  /** Command to start the dev server (e.g. "bun dev"). */
  readonly startCommand?: string | undefined
  /** Mount point inside the container. Defaults to "/app". */
  readonly workdir?: string | undefined
}

/**
 * Shape of a `laborer.json` config file.
 * All fields are optional — missing fields are resolved from ancestor
 * configs or hardcoded defaults.
 */
interface LaborerConfig {
  readonly devServer?: DevServerConfig
  readonly prdsDir?: string
  readonly rlphConfig?: string
  readonly setupScripts?: readonly string[]
  readonly watchIgnore?: readonly string[]
  readonly worktreeDir?: string
}

/** Partial updates accepted by writeProjectConfig(). */
interface ProjectConfigUpdates {
  readonly devServer?: DevServerConfig | undefined
  readonly prdsDir?: string | undefined
  readonly rlphConfig?: string | undefined
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
  readonly dockerfile: ResolvedValue<string | null>
  readonly image: ResolvedValue<string | null>
  readonly setupScripts: ResolvedValue<readonly string[]>
  readonly startCommand: ResolvedValue<string | null>
  readonly workdir: ResolvedValue<string>
}

/**
 * Fully resolved config with provenance for each field.
 * All fields have concrete values (no undefined).
 */
interface ResolvedLaborerConfig {
  readonly devServer: ResolvedDevServerConfig
  /** Absolute path with `~` already expanded. */
  readonly prdsDir: ResolvedValue<string>
  readonly rlphConfig: ResolvedValue<string | null>
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
      try: () => JSON.parse(content) as LaborerConfig,
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
          return {} as LaborerConfig
        })
      )
    )

    return parsed
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
 * Apply explicit config updates to an existing config object.
 * Undefined fields in updates are ignored (do not overwrite existing values).
 */
const applyConfigUpdates = (
  existing: Record<string, unknown>,
  updates: ProjectConfigUpdates
): Record<string, unknown> => {
  const next = { ...existing }

  if (updates.prdsDir !== undefined) {
    next.prdsDir = updates.prdsDir
  }

  if (updates.worktreeDir !== undefined) {
    next.worktreeDir = updates.worktreeDir
  }

  if (updates.setupScripts !== undefined) {
    next.setupScripts = [...updates.setupScripts]
  }

  if (updates.rlphConfig !== undefined) {
    next.rlphConfig = updates.rlphConfig
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
    const merged = { ...existingDevServer }

    if (updates.devServer.image !== undefined) {
      merged.image = updates.devServer.image
    }
    if (updates.devServer.dockerfile !== undefined) {
      merged.dockerfile = updates.devServer.dockerfile
    }
    if (updates.devServer.setupScripts !== undefined) {
      merged.setupScripts = [...updates.devServer.setupScripts]
    }
    if (updates.devServer.startCommand !== undefined) {
      merged.startCommand = updates.devServer.startCommand
    }
    if (updates.devServer.workdir !== undefined) {
      merged.workdir = updates.devServer.workdir
    }

    next.devServer = merged
  }

  return next
}

/**
 * Atomically write JSON to a path by writing a temp file and renaming.
 */
const writeJsonAtomic = (
  targetPath: string,
  content: Record<string, unknown>
): Effect.Effect<void, never> =>
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
    }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`${error.message}: ${String(error.cause)}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      )
    )

    yield* Effect.try({
      try: () => renameSync(tempPath, targetPath),
      catch: (cause) =>
        new ConfigIOError({
          message: `Failed to atomically move ${tempPath} to ${targetPath}`,
          cause,
        }),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`${error.message}: ${String(error.cause)}`).pipe(
          Effect.annotateLogs('module', logPrefix)
        )
      )
    )
  })

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
  let image: ResolvedValue<string | null> = {
    value: 'oven/bun:latest',
    source: 'default',
  }
  let dockerfile: ResolvedValue<string | null> = {
    value: null,
    source: 'default',
  }
  let setupScripts: ResolvedValue<readonly string[]> = {
    value: [
      'apt-get update && apt-get install -y python3',
      'bun add -g pnpm',
      'exec bash',
    ],
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

  const applyDevServerLayer = (ds: DevServerConfig, path: string) => {
    if (ds.image !== undefined) {
      image = { value: ds.image, source: path }
      // image and dockerfile are mutually exclusive — setting one clears the other
      if (ds.dockerfile === undefined) {
        dockerfile = { value: null, source: 'default' }
      }
    }
    if (ds.dockerfile !== undefined) {
      dockerfile = { value: ds.dockerfile, source: path }
      // image and dockerfile are mutually exclusive — setting one clears the other
      if (ds.image === undefined) {
        image = { value: null, source: 'default' }
      }
    }
    if (ds.setupScripts !== undefined) {
      setupScripts = { value: ds.setupScripts, source: path }
    }
    if (ds.startCommand !== undefined) {
      startCommand = { value: ds.startCommand, source: path }
    }
    if (ds.workdir !== undefined) {
      workdir = { value: ds.workdir, source: path }
    }
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

  return { dockerfile, image, setupScripts, startCommand, workdir }
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
  return undefined
}

const mergeConfigs = (
  configLayers: ReadonlyArray<{ config: LaborerConfig; path: string }>,
  projectName: string
): ResolvedLaborerConfig => {
  const defaultWorktreeDir = join(GLOBAL_CONFIG_DIR, projectName)
  const defaultPrdsDir = join(defaultWorktreeDir, 'prds')

  let worktreeDir: ResolvedValue<string> = {
    value: defaultWorktreeDir,
    source: 'default',
  }
  let prdsDir: ResolvedValue<string> = {
    value: defaultPrdsDir,
    source: 'default',
  }
  let setupScripts: ResolvedValue<readonly string[]> = {
    value: [],
    source: 'default',
  }
  let rlphConfig: ResolvedValue<string | null> = {
    value: null,
    source: 'default',
  }
  let watchIgnore: ResolvedValue<readonly string[]> = {
    value: [],
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

    if (config.worktreeDir !== undefined) {
      worktreeDir = {
        value: resolve(expandTilde(config.worktreeDir)),
        source: path,
      }
      if (prdsDir.source === 'default') {
        prdsDir = {
          value: join(worktreeDir.value, 'prds'),
          source: 'default',
        }
      }
    }

    if (config.prdsDir !== undefined) {
      prdsDir = {
        value: resolve(expandTilde(config.prdsDir)),
        source: path,
      }
    }

    if (config.setupScripts !== undefined) {
      setupScripts = {
        value: config.setupScripts,
        source: path,
      }
    }

    if (config.rlphConfig !== undefined) {
      rlphConfig = {
        value: config.rlphConfig,
        source: path,
      }
    }

    if (config.watchIgnore !== undefined) {
      watchIgnore = {
        value: config.watchIgnore,
        source: path,
      }
    }
  }

  const devServer = mergeDevServerConfig(configLayers)

  return {
    devServer,
    prdsDir,
    worktreeDir,
    setupScripts,
    rlphConfig,
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
        const resolved = mergeConfigs(allLayers, projectName)

        // 6. Validate devServer mutual exclusion (image vs dockerfile)
        const validationError = validateDevServerConfig(resolved.devServer)
        if (validationError !== undefined) {
          return yield* new ConfigValidationError({
            message: validationError,
          })
        }

        yield* Effect.logDebug(
          `Resolved config for "${projectName}": worktreeDir="${resolved.worktreeDir.value}" (from ${resolved.worktreeDir.source}), prdsDir="${resolved.prdsDir.value}" (from ${resolved.prdsDir.source}), setupScripts=${resolved.setupScripts.value.length} (from ${resolved.setupScripts.source}), rlphConfig=${resolved.rlphConfig.value ?? 'null'} (from ${resolved.rlphConfig.source}), devServer.image=${resolved.devServer.image.value ?? 'null'} (from ${resolved.devServer.image.source}), devServer.workdir="${resolved.devServer.workdir.value}" (from ${resolved.devServer.workdir.source})`
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
    })
  )
}

export {
  ConfigService,
  ConfigValidationError,
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
}
