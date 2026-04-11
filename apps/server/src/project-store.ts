import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import path, { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProjectId, makeWorkspaceId } from '@laborer/contracts/base'
import {
  buildProjectsSnapshot,
  PROJECTS_LIVESTORE_ID,
  projectStoreEvents,
  projectStoreSchema,
  projectStoreTables,
} from '@laborer/contracts/livestore'
import {
  type Project,
  type ProjectsAddInput,
  ProjectsCreateWorkspaceError,
  type ProjectsCreateWorkspaceInput,
  type ProjectsEvent,
  type ProjectsSnapshot,
  type ProjectWorkspace,
} from '@laborer/contracts/projects'
import { makeAdapter } from '@livestore/adapter-node'
import { createStore, provideOtel, type Store } from '@livestore/livestore'
import { Context, Effect, Layer, Match, Option, PubSub, Stream } from 'effect'

const DEFAULT_PROJECT_STORE_STORAGE_DIRECTORY = fileURLToPath(
  new URL('../.livestore', import.meta.url)
)
const PROJECT_STORE_STORAGE_DIRECTORY =
  process.env.LABORER_PROJECT_STORE_DIRECTORY?.trim() ||
  DEFAULT_PROJECT_STORE_STORAGE_DIRECTORY

const projectStoreAdapter = makeAdapter({
  storage: {
    type: 'fs',
    baseDirectory: PROJECT_STORE_STORAGE_DIRECTORY,
  },
})

type ProjectsStore = Store<typeof projectStoreSchema>

const publishProjectEvent = (
  events: PubSub.PubSub<ProjectsEvent>,
  event: ProjectsEvent
) => PubSub.publish(events, event).pipe(Effect.asVoid)

const makeAdd = (store: ProjectsStore, events: PubSub.PubSub<ProjectsEvent>) =>
  Effect.fn('ProjectStore.add')(function* (input: ProjectsAddInput) {
    const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot)
    const current = readProjectsSnapshot(store)
    const existingProject = current.projects.find(
      (project) =>
        normalizeWorkspaceRoot(project.workspaceRoot) === workspaceRoot
    )
    const existingProjectOption = Option.fromNullable(existingProject)
    const project = Option.getOrElse(
      existingProjectOption,
      () =>
        ({
          id: makeProjectId(crypto.randomUUID()),
          name: resolveProjectName(workspaceRoot),
          workspaceRoot,
          workspaces: [],
        }) satisfies Project
    )
    const shouldPublishProject = Option.isNone(existingProjectOption)
    const commitProject = Effect.sync(() => {
      store.commit(
        projectStoreEvents.projectAdded({
          project,
          sortOrder: getNextProjectSortOrder(store),
        })
      )
    })

    yield* Effect.when(commitProject, () => shouldPublishProject)
    yield* Effect.when(
      publishProjectEvent(events, {
        version: 1,
        type: 'projectAdded',
        payload: {
          project,
        },
      }),
      () => shouldPublishProject
    )

    return project
  })

const makeCreateWorkspace = (
  store: ProjectsStore,
  events: PubSub.PubSub<ProjectsEvent>
) =>
  Effect.fn('ProjectStore.createWorkspace')(function* (
    input: ProjectsCreateWorkspaceInput
  ) {
    const current = readProjectsSnapshot(store)

    const project = yield* Effect.fromNullable(
      current.projects.find((candidate) => candidate.id === input.projectId)
    ).pipe(
      Effect.orElseFail(
        () =>
          new ProjectsCreateWorkspaceError({
            message: 'Unable to create a workspace for a missing project.',
          })
      )
    )

    const repoRoot = yield* Effect.tryPromise({
      try: () => resolveGitRepositoryRoot(project.workspaceRoot),
      catch: (cause) =>
        new ProjectsCreateWorkspaceError({
          message: buildCreateWorkspaceErrorMessage(input.name, cause),
          cause,
        }),
    })
    const currentBranch = yield* Effect.tryPromise({
      try: () => resolveCurrentGitBranch(project.workspaceRoot),
      catch: (cause) =>
        new ProjectsCreateWorkspaceError({
          message: buildCreateWorkspaceErrorMessage(input.name, cause),
          cause,
        }),
    })
    const workspaceRoot = resolveWorkspaceRoot(repoRoot, input.name)

    yield* Effect.tryPromise({
      try: () =>
        createGitWorktree({
          cwd: project.workspaceRoot,
          currentBranch,
          newBranch: input.name,
          workspaceRoot,
        }),
      catch: (cause) =>
        new ProjectsCreateWorkspaceError({
          message: buildCreateWorkspaceErrorMessage(input.name, cause),
          cause,
        }),
    })

    const workspace = {
      id: makeWorkspaceId(crypto.randomUUID()),
      name: input.name,
      workspaceRoot,
      updatedAt: new Date().toISOString(),
    } satisfies ProjectWorkspace

    yield* Effect.sync(() => {
      store.commit(
        projectStoreEvents.workspaceAdded({
          projectId: input.projectId,
          workspace,
          sortOrder: getNextWorkspaceSortOrder(store, input.projectId),
        })
      )
    })
    yield* publishProjectEvent(events, {
      version: 1,
      type: 'workspaceAdded',
      payload: {
        projectId: input.projectId,
        workspace,
      },
    })

    return workspace
  })

const makeList = (store: ProjectsStore) =>
  Effect.fn('ProjectStore.list')(() =>
    Effect.sync(() => readProjectsSnapshot(store))
  )

const streamProjectEvents = (events: PubSub.PubSub<ProjectsEvent>) =>
  Stream.fromPubSub(events)

export interface ProjectStoreShape {
  readonly add: ReturnType<typeof makeAdd>
  readonly createWorkspace: ReturnType<typeof makeCreateWorkspace>
  readonly list: ReturnType<typeof makeList>
  readonly stream: ReturnType<typeof streamProjectEvents>
}

export class ProjectStore extends Context.Tag('@laborer/server/ProjectStore')<
  ProjectStore,
  ProjectStoreShape
>() {
  static readonly layer = Layer.scoped(
    this,
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProjectsEvent>()
      const store = yield* createStore({
        adapter: projectStoreAdapter,
        schema: projectStoreSchema,
        storeId: PROJECTS_LIVESTORE_ID,
        disableDevtools: true,
      }).pipe(provideOtel({}))

      return ProjectStore.of({
        add: makeAdd(store, events),
        createWorkspace: makeCreateWorkspace(store, events),
        list: makeList(store),
        stream: streamProjectEvents(events),
      })
    })
  )
}

const TRAILING_PATH_SEPARATOR_PATTERN = /[\\/]+$/

const normalizeWorkspaceRoot = (workspaceRoot: string): string => {
  const trimmed = workspaceRoot.trim()
  return trimmed.replace(TRAILING_PATH_SEPARATOR_PATTERN, '') || trimmed
}

const resolveProjectName = (workspaceRoot: string): string => {
  const name = basename(workspaceRoot)

  return Match.value(name.length > 0).pipe(
    Match.when(true, () => name),
    Match.orElse(() => workspaceRoot)
  )
}

const readProjectsSnapshot = (store: ProjectsStore): ProjectsSnapshot =>
  buildProjectsSnapshot(
    store.query(
      projectStoreTables.projects.select().orderBy('sortOrder', 'asc')
    ),
    store.query(
      projectStoreTables.projectWorkspaces.select().orderBy('sortOrder', 'asc')
    )
  )

const getNextProjectSortOrder = (store: ProjectsStore): number => {
  const [firstProject] = store.query(
    projectStoreTables.projects
      .select('sortOrder')
      .orderBy('sortOrder', 'asc')
      .limit(1)
  )

  return Option.match(Option.fromNullable(firstProject), {
    onNone: () => 0,
    onSome: (sortOrder) => sortOrder - 1,
  })
}

const getNextWorkspaceSortOrder = (
  store: ProjectsStore,
  projectId: Project['id']
): number => {
  const [firstWorkspace] = store.query(
    projectStoreTables.projectWorkspaces
      .select('sortOrder')
      .where({ projectId })
      .orderBy('sortOrder', 'asc')
      .limit(1)
  )

  return Option.match(Option.fromNullable(firstWorkspace), {
    onNone: () => 0,
    onSome: (sortOrder) => sortOrder - 1,
  })
}

const buildCreateWorkspaceErrorMessage = (
  workspaceName: string,
  cause: unknown
): string =>
  Match.value(cause).pipe(
    Match.when(
      (candidate: unknown): candidate is Error =>
        candidate instanceof Error && candidate.message.trim().length > 0,
      (error) => `Unable to create workspace ${workspaceName}: ${error.message}`
    ),
    Match.orElse(() => `Unable to create workspace ${workspaceName}.`)
  )

const resolveWorkspaceRoot = (
  repoRoot: string,
  workspaceName: string
): string => {
  const sanitizedBranch = workspaceName.replaceAll('/', '-')
  return path.join(`${repoRoot}.worktrees`, sanitizedBranch)
}

const resolveGitRepositoryRoot = async (cwd: string): Promise<string> => {
  const { stdout } = await runGitCommand(cwd, ['rev-parse', '--show-toplevel'])
  return stdout.trim()
}

const resolveCurrentGitBranch = async (cwd: string): Promise<string> => {
  const { stdout } = await runGitCommand(cwd, ['branch', '--show-current'])
  const branch = stdout.trim()

  return Match.value(branch).pipe(
    Match.when(
      (currentBranch) => currentBranch.length > 0,
      (currentBranch) => currentBranch
    ),
    Match.orElse(() => {
      throw new Error('Repository is not checked out on a branch.')
    })
  )
}

const buildGitCommandFailureMessage = (
  args: readonly string[],
  error: Error,
  stderr: string
) =>
  Match.value({ error: error.message.trim(), stderr: stderr.trim() }).pipe(
    Match.when(
      (input) => input.stderr.length > 0,
      (input) => input.stderr
    ),
    Match.when(
      (input) => input.error.length > 0,
      (input) => input.error
    ),
    Match.orElse(() => `git ${args.join(' ')} failed`)
  )

const createGitWorktree = async (input: {
  readonly cwd: string
  readonly currentBranch: string
  readonly newBranch: string
  readonly workspaceRoot: string
}): Promise<void> => {
  await mkdir(path.dirname(input.workspaceRoot), { recursive: true })
  await runGitCommand(input.cwd, [
    'worktree',
    'add',
    '-b',
    input.newBranch,
    input.workspaceRoot,
    input.currentBranch,
  ])
}

const runGitCommand = (
  cwd: string,
  args: readonly string[]
): Promise<{ readonly stderr: string; readonly stdout: string }> =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        Match.value(error).pipe(
          Match.when(
            (candidate): candidate is Error => candidate instanceof Error,
            (gitError) => {
              reject(
                new Error(buildGitCommandFailureMessage(args, gitError, stderr))
              )
            }
          ),
          Match.orElse(() => {
            resolve({ stderr, stdout })
          })
        )
    )
  })
