import { basename } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import { Context, Effect, Layer } from 'effect'
import { BranchStateTracker } from './branch-state-tracker.js'
import { LaborerDatabase } from './laborer-database.js'
import type { Project } from './native-laborer-database.js'
import { RepositoryIdentity } from './repository-identity.js'
import { RepositoryWatchCoordinator } from './repository-watch-coordinator.js'
import { WorktreeReconciler } from './worktree-reconciler.js'

export interface ProjectRecord {
  readonly canonicalGitCommonDir: string | null
  readonly id: string
  readonly name: string
  readonly repoId: string | null
  readonly repoPath: string
}

const projectRecord = (project: Project): ProjectRecord => ({
  ...project,
  repoPath: project.rootPath,
})

const databaseRpcError = (operation: string, cause: unknown) =>
  new RpcError({
    code: 'PROJECT_DATABASE_ERROR',
    message: `Could not ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  })

class ProjectRegistry extends Context.Tag('@laborer/ProjectRegistry')<
  ProjectRegistry,
  {
    readonly addProject: (
      repoPath: string,
      rePointExisting?: boolean
    ) => Effect.Effect<ProjectRecord, RpcError>
    readonly removeProject: (projectId: string) => Effect.Effect<void, RpcError>
    readonly listProjects: () => Effect.Effect<
      readonly ProjectRecord[],
      RpcError
    >
    readonly getProject: (
      projectId: string
    ) => Effect.Effect<ProjectRecord, RpcError>
  }
>() {
  static readonly layer = Layer.effect(
    ProjectRegistry,
    Effect.gen(function* () {
      const database = yield* LaborerDatabase
      const repoIdentity = yield* RepositoryIdentity
      const worktreeReconciler = yield* WorktreeReconciler
      const branchTracker = yield* BranchStateTracker
      const watchCoordinator = yield* RepositoryWatchCoordinator

      const prepareProject = (project: ProjectRecord) =>
        Effect.gen(function* () {
          yield* worktreeReconciler
            .reconcile(project.id, project.repoPath)
            .pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `Initial worktree reconciliation failed for project ${project.repoPath}: ${error.message}`
                )
              )
            )
          yield* branchTracker
            .refreshBranches(project.id)
            .pipe(
              Effect.catchAll((error) =>
                Effect.logWarning(
                  `Initial branch refresh failed for project ${project.repoPath}: ${error.message}`
                )
              )
            )
          yield* watchCoordinator.watchProject(
            project.id,
            project.repoPath,
            project.name,
            project.canonicalGitCommonDir ?? undefined
          )
          return project
        })

      const addProject = Effect.fn('ProjectRegistry.addProject')(function* (
        repoPath: string,
        rePointExisting = true
      ) {
        const identity = yield* repoIdentity.resolve(repoPath).pipe(
          Effect.mapError((error) => {
            const isPathError =
              error.message.includes('does not exist') ||
              error.message.includes('not a directory')
            return new RpcError({
              message: isPathError
                ? error.message
                : `Path is not a git repository: ${repoPath}`,
              code: isPathError ? 'INVALID_PATH' : 'NOT_GIT_REPO',
            })
          })
        )
        const existing = yield* database
          .run('find project by repository identity', (db) =>
            db.findProjectByRepoId(identity.repoId)
          )
          .pipe(
            Effect.mapError((cause) => databaseRpcError('read projects', cause))
          )

        if (existing && !rePointExisting) {
          return projectRecord(existing)
        }
        if (
          existing?.rootPath === identity.canonicalRoot ||
          existing?.canonicalGitCommonDir === identity.canonicalGitCommonDir
        ) {
          return yield* new RpcError({
            message: `${repoPath} resolves to the already registered repository ${existing.rootPath} (project ${existing.name})`,
            code: 'ALREADY_REGISTERED',
          })
        }
        const name = basename(identity.canonicalRoot)
        const stored = existing
          ? yield* database
              .run(
                're-point project',
                (db) =>
                  db.updateProject(existing.id, existing.revision, {
                    canonicalGitCommonDir: identity.canonicalGitCommonDir,
                    name,
                    rootPath: identity.canonicalRoot,
                  }).row
              )
              .pipe(
                Effect.mapError((cause) =>
                  databaseRpcError('re-point project', cause)
                )
              )
          : yield* database
              .run(
                'register project',
                (db) =>
                  db.insertProject({
                    id: crypto.randomUUID(),
                    name,
                    rootPath: identity.canonicalRoot,
                    repoId: identity.repoId,
                    canonicalGitCommonDir: identity.canonicalGitCommonDir,
                  }).row
              )
              .pipe(
                Effect.mapError((cause) =>
                  databaseRpcError('register project', cause)
                )
              )

        return yield* prepareProject(projectRecord(stored))
      })

      const removeProject = Effect.fn('ProjectRegistry.removeProject')(
        function* (projectId: string) {
          const existing = yield* database
            .run('find project', (db) => db.findProject(projectId))
            .pipe(
              Effect.mapError((cause) =>
                databaseRpcError('read project', cause)
              )
            )
          if (existing === null) {
            return yield* new RpcError({
              message: `Project not found: ${projectId}`,
              code: 'NOT_FOUND',
            })
          }
          yield* watchCoordinator.unwatchProject(projectId)
          yield* database
            .run('remove project', (db) =>
              db.deleteProject(projectId, existing.revision)
            )
            .pipe(
              Effect.mapError((cause) =>
                databaseRpcError('remove project', cause)
              )
            )
        }
      )

      const listProjects = () =>
        database
          .run('list projects', (db) => db.listProjects().map(projectRecord))
          .pipe(
            Effect.mapError((cause) => databaseRpcError('list projects', cause))
          )

      const getProject = Effect.fn('ProjectRegistry.getProject')(function* (
        projectId: string
      ) {
        const project = yield* database
          .run('find project', (db) => db.findProject(projectId))
          .pipe(
            Effect.mapError((cause) => databaseRpcError('read project', cause))
          )
        if (project === null) {
          return yield* new RpcError({
            message: `Project not found: ${projectId}`,
            code: 'NOT_FOUND',
          })
        }
        return projectRecord(project)
      })

      return ProjectRegistry.of({
        addProject,
        removeProject,
        listProjects,
        getProject,
      })
    })
  )
}

export { ProjectRegistry }
