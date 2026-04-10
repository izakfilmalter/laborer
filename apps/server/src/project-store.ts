import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeProjectId, makeThreadId } from '@laborer/contracts/base'
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
  ProjectsCreateThreadError,
  type ProjectsCreateThreadInput,
  type ProjectsEvent,
  type ProjectsSnapshot,
  type ProjectThread,
} from '@laborer/contracts/projects'
import { makeAdapter } from '@livestore/adapter-node'
import { createStore, provideOtel, type Store } from '@livestore/livestore'
import { Context, Effect, Layer, Match, Option, PubSub, Stream } from 'effect'

const PROJECT_STORE_STORAGE_DIRECTORY = fileURLToPath(
  new URL('../.livestore', import.meta.url)
)

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
          threads: [],
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

const makeCreateThread = (
  store: ProjectsStore,
  events: PubSub.PubSub<ProjectsEvent>
) =>
  Effect.fn('ProjectStore.createThread')(function* (
    input: ProjectsCreateThreadInput
  ) {
    const current = readProjectsSnapshot(store)

    yield* Effect.fromNullable(
      current.projects.find((project) => project.id === input.projectId)
    ).pipe(
      Effect.orElseFail(
        () =>
          new ProjectsCreateThreadError({
            message: 'Unable to create a thread for a missing project.',
          })
      )
    )

    const thread = {
      id: makeThreadId(crypto.randomUUID()),
      title: 'New thread',
      updatedAt: new Date().toISOString(),
    } satisfies ProjectThread

    yield* Effect.sync(() => {
      store.commit(
        projectStoreEvents.threadAdded({
          projectId: input.projectId,
          thread,
          sortOrder: getNextThreadSortOrder(store, input.projectId),
        })
      )
    })
    yield* publishProjectEvent(events, {
      version: 1,
      type: 'threadAdded',
      payload: {
        projectId: input.projectId,
        thread,
      },
    })

    return thread
  })

const makeList = (store: ProjectsStore) =>
  Effect.fn('ProjectStore.list')(() =>
    Effect.sync(() => readProjectsSnapshot(store))
  )

const streamProjectEvents = (events: PubSub.PubSub<ProjectsEvent>) =>
  Stream.fromPubSub(events)

export interface ProjectStoreShape {
  readonly add: ReturnType<typeof makeAdd>
  readonly createThread: ReturnType<typeof makeCreateThread>
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
        createThread: makeCreateThread(store, events),
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
      projectStoreTables.projectThreads.select().orderBy('sortOrder', 'asc')
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

const getNextThreadSortOrder = (
  store: ProjectsStore,
  projectId: Project['id']
): number => {
  const [firstThread] = store.query(
    projectStoreTables.projectThreads
      .select('sortOrder')
      .where({ projectId })
      .orderBy('sortOrder', 'asc')
      .limit(1)
  )

  return Option.match(Option.fromNullable(firstThread), {
    onNone: () => 0,
    onSome: (sortOrder) => sortOrder - 1,
  })
}
