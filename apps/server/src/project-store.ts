import { basename } from 'node:path'

import { makeProjectId, makeThreadId } from '@laborer/contracts/base'
import {
  type Project,
  type ProjectsAddInput,
  ProjectsCreateThreadError,
  type ProjectsCreateThreadInput,
  type ProjectsEvent,
  type ProjectsSnapshot,
  type ProjectThread,
} from '@laborer/contracts/projects'
import {
  Context,
  Effect,
  Layer,
  Match,
  Option,
  PubSub,
  Ref,
  Stream,
} from 'effect'

const publishProjectEvent = (
  events: PubSub.PubSub<ProjectsEvent>,
  event: ProjectsEvent
) => PubSub.publish(events, event).pipe(Effect.asVoid)

const makeAdd = (
  state: Ref.Ref<ProjectsSnapshot>,
  events: PubSub.PubSub<ProjectsEvent>
) =>
  Effect.fn('ProjectStore.add')(function* (input: ProjectsAddInput) {
    const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot)
    const current = yield* Ref.get(state)
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

    yield* Effect.when(
      Ref.set(state, {
        projects: [project, ...current.projects],
      }),
      () => shouldPublishProject
    )
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
  state: Ref.Ref<ProjectsSnapshot>,
  events: PubSub.PubSub<ProjectsEvent>
) =>
  Effect.fn('ProjectStore.createThread')(function* (
    input: ProjectsCreateThreadInput
  ) {
    const current = yield* Ref.get(state)

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

    yield* Ref.set(state, {
      projects: current.projects.map((project) =>
        Match.value(project.id).pipe(
          Match.when(input.projectId, () => ({
            ...project,
            threads: [thread, ...project.threads],
          })),
          Match.orElse(() => project)
        )
      ),
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

const getProjectSnapshot = (state: Ref.Ref<ProjectsSnapshot>) => Ref.get(state)

const streamProjectEvents = (events: PubSub.PubSub<ProjectsEvent>) =>
  Stream.fromPubSub(events)

export interface ProjectStoreShape {
  readonly add: ReturnType<typeof makeAdd>
  readonly createThread: ReturnType<typeof makeCreateThread>
  readonly list: ReturnType<typeof getProjectSnapshot>
  readonly stream: ReturnType<typeof streamProjectEvents>
}

export class ProjectStore extends Context.Tag('@laborer/server/ProjectStore')<
  ProjectStore,
  ProjectStoreShape
>() {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProjectsEvent>()
      const state = yield* Ref.make<ProjectsSnapshot>({
        projects: [],
      })

      return ProjectStore.of({
        add: makeAdd(state, events),
        createThread: makeCreateThread(state, events),
        list: getProjectSnapshot(state),
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
