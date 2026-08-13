import { resolve } from 'node:path'
import { Effect, Array as EffectArray, Schema } from 'effect'
import { isSensitiveCredentialEnvironmentName } from '../adapters/sensitive-environment.ts'
import {
  assertNoSymlinkPathComponents,
  assertSafeFilePath,
  canonicalDirectory,
  openRegularFileNoFollow,
  retainTrustedDirectory,
  verifyRetainedDirectory,
} from '../core/path-safety.ts'
import { LaborerConfigError } from './errors.ts'

export interface ReferenceCodingApplicationConfig {
  readonly environment: readonly string[]
  readonly implementation?: {
    readonly agent?: string
    readonly model?: string
  }
  readonly type: 'reference-coding'
}

export type LaborerConfig = Readonly<Record<string, unknown>> & {
  readonly application: ReferenceCodingApplicationConfig
}

export interface LoadedLaborerConfig {
  readonly config: LaborerConfig
  readonly root: string
}

const configFailure = (operation: string, reason: string): LaborerConfigError =>
  LaborerConfigError.make({ operation, reason })

const HandlerCommand = Schema.Trim.check(Schema.isMinLength(1))
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const OPENCODE_MODEL_PATTERN = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/
const OpenCodeModel = Schema.Trim.check(
  Schema.isPattern(OPENCODE_MODEL_PATTERN)
)
const ImplementationApplicationConfigFromJson = Schema.Struct({
  agent: Schema.optional(HandlerCommand),
  model: Schema.optional(OpenCodeModel),
})

const ReferenceCodingApplicationConfigFromJson = Schema.Struct({
  environment: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([]))
  ),
  implementation: Schema.optional(ImplementationApplicationConfigFromJson),
  type: Schema.Literal('reference-coding'),
})

const LaborerConfigFromJson = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      application: Schema.optional(ReferenceCodingApplicationConfigFromJson),
    }),
    [Schema.Record(Schema.String, Schema.Unknown)]
  )
)

const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true })
const LEGACY_CONVERSATION_CONFIG_KEYS = [
  'conversation',
  'agent',
  'model',
  'protocol',
  'protocolVersion',
] as const

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

const acpConfigMigrationIssue = (source: string): string | null => {
  let decoded: unknown
  try {
    decoded = JSON.parse(source) as unknown
  } catch {
    return null
  }
  const root = objectRecord(decoded)
  if (root !== null && Object.hasOwn(root, 'workHandler')) {
    return 'configured-work-handler-retired'
  }
  const application = objectRecord(root?.application)
  if (application === null) {
    return null
  }
  if (
    LEGACY_CONVERSATION_CONFIG_KEYS.some((key) =>
      Object.hasOwn(application, key)
    )
  ) {
    return 'legacy-conversation-config-removed-use-opencode-agent-model-config'
  }
  return null
}

const validateAcpConfigMigration = (
  source: string
): Effect.Effect<void, LaborerConfigError> => {
  const issue = acpConfigMigrationIssue(source)
  return issue === null
    ? Effect.void
    : configFailure('migrate-acp-config', issue)
}

const implementationConfig = (
  raw: typeof ImplementationApplicationConfigFromJson.Type | undefined
): Pick<ReferenceCodingApplicationConfig, 'implementation'> | object =>
  raw === undefined
    ? {}
    : {
        implementation: {
          ...(raw.agent === undefined ? {} : { agent: raw.agent }),
          ...(raw.model === undefined ? {} : { model: raw.model }),
        },
      }

const validateEnvironmentNames = (
  names: readonly string[],
  operation: string
): Effect.Effect<readonly string[], LaborerConfigError> => {
  const invalidName = EffectArray.findFirst(
    names,
    (name) =>
      !ENVIRONMENT_NAME_PATTERN.test(name) ||
      isSensitiveCredentialEnvironmentName(name)
  )
  if (invalidName._tag === 'Some') {
    return configFailure(operation, 'invalid-environment-name')
  }
  if (EffectArray.dedupe(names).length !== names.length) {
    return configFailure(operation, 'duplicate-environment-name')
  }
  return Effect.succeed(names)
}

const readConfig = async (root: string): Promise<string> => {
  const path = resolve(root, 'laborer.json')
  const retainedRoot = await retainTrustedDirectory(root, 'read-laborer-config')
  try {
    await assertSafeFilePath({
      anchor: root,
      operation: 'read-laborer-config',
      path,
    })
    const file = await openRegularFileNoFollow(path, 'read-laborer-config')
    try {
      const source = fatalUtf8Decoder.decode(await file.readFile())
      await verifyRetainedDirectory(retainedRoot, 'read-laborer-config')
      return source
    } finally {
      await file.close()
    }
  } finally {
    await retainedRoot.handle.close()
  }
}

export const loadLaborerConfig = Effect.fn('loadLaborerConfig')(
  function* (options: {
    readonly defaultRoot: string
    readonly environment?: NodeJS.ProcessEnv
  }) {
    const environment = options.environment ?? process.env
    const configuredRoot = Object.hasOwn(environment, 'LABORER_ROOT')
      ? environment.LABORER_ROOT
      : options.defaultRoot
    if (configuredRoot === undefined || configuredRoot.trim().length === 0) {
      return yield* configFailure('resolve-root', 'root-blank')
    }
    const root = yield* Effect.tryPromise({
      try: async () => {
        await assertNoSymlinkPathComponents(
          configuredRoot,
          'resolve-laborer-root'
        )
        return await canonicalDirectory(configuredRoot, 'resolve-laborer-root')
      },
      catch: () => configFailure('resolve-root', 'root-unsafe-or-unavailable'),
    })
    const source = yield* Effect.tryPromise({
      try: () => readConfig(root),
      catch: () => configFailure('read-config', 'config-unavailable'),
    })
    yield* validateAcpConfigMigration(source)
    const rawConfig = yield* Schema.decodeUnknownEffect(LaborerConfigFromJson, {
      onExcessProperty: 'error',
    })(source).pipe(
      Effect.mapError(() => configFailure('parse-config', 'invalid-config'))
    )
    if (rawConfig.application === undefined) {
      return yield* configFailure('parse-config', 'invalid-config')
    }
    const application: ReferenceCodingApplicationConfig = {
      environment: yield* validateEnvironmentNames(
        rawConfig.application.environment,
        'validate-reference-coding-application'
      ),
      ...implementationConfig(rawConfig.application.implementation),
      type: 'reference-coding',
    }
    return { config: { ...rawConfig, application }, root }
  }
)
