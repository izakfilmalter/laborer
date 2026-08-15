import { RpcError } from '@laborer/shared/rpc'
import { Array, Effect, Semaphore } from 'effect'
import type { ConfigService } from './config-service.js'

export interface ProjectTaskIdentifierNamespace {
  readonly aliases: readonly string[]
  readonly id: string
  readonly name: string
  readonly repoPath: string
  readonly shortName: string
}

interface ProjectIdentity {
  readonly id: string
  readonly name: string
  readonly repoPath: string
}

const namespaceSemaphore = Semaphore.makeUnsafe(1)

export const withProjectIdentifierNamespaceLock = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => namespaceSemaphore.withPermits(1)(effect)

export const resolveProjectTaskIdentifierNamespaces = (
  projects: readonly ProjectIdentity[],
  configService: ConfigService['Service']
) =>
  Effect.forEach(projects, (project) =>
    configService.resolveConfig(project.repoPath, project.name).pipe(
      Effect.map((config) => ({
        ...project,
        aliases: config.shortNameAliases.value,
        shortName: config.shortName.value,
      }))
    )
  )

const namespaceKeys = (
  namespace: Pick<ProjectTaskIdentifierNamespace, 'aliases' | 'shortName'>
): readonly string[] => [namespace.shortName, ...namespace.aliases]

export const validateProjectTaskIdentifierNamespace = (
  candidate: ProjectTaskIdentifierNamespace,
  existing: readonly ProjectTaskIdentifierNamespace[]
): Effect.Effect<void, RpcError> => {
  const conflict = Array.findFirst(
    existing,
    (project) =>
      project.id !== candidate.id &&
      Array.some(namespaceKeys(project), (key) =>
        namespaceKeys(candidate).includes(key)
      )
  )
  if (conflict._tag === 'None') {
    return Effect.void
  }
  const project = conflict.value
  const key = namespaceKeys(candidate).find((value) =>
    namespaceKeys(project).includes(value)
  )
  return new RpcError({
    code: 'PROJECT_SHORT_NAME_CONFLICT',
    message: `Project key ${key ?? candidate.shortName} is already used by ${project.name}. Choose a unique project short name.`,
  })
}

export const aliasesAfterRename = (
  currentShortName: string,
  currentAliases: readonly string[],
  nextShortName: string
): readonly string[] =>
  [...new Set([...currentAliases, currentShortName])].filter(
    (alias) => alias !== nextShortName
  )
