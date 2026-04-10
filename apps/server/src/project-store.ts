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
import { Context, Effect, Layer, PubSub, Ref, Stream } from 'effect'

export interface ProjectStoreShape {
  readonly add: (input: ProjectsAddInput) => Effect.Effect<Project>
  readonly createThread: (
    input: ProjectsCreateThreadInput
  ) => Effect.Effect<ProjectThread, ProjectsCreateThreadError>
  readonly list: Effect.Effect<ProjectsSnapshot>
  readonly stream: Stream.Stream<ProjectsEvent>
}

export class ProjectStore extends Context.Service<
  ProjectStore,
  ProjectStoreShape
>()('@laborer/server/ProjectStore') {
  static readonly layer = Layer.effect(
    ProjectStore,
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProjectsEvent>()
      const state = yield* Ref.make<ProjectsSnapshot>({
        projects: [],
      })

      const publish = (event: ProjectsEvent) =>
        PubSub.publish(events, event).pipe(Effect.asVoid)

      const add = Effect.fn('ProjectStore.add')(function* (
        input: ProjectsAddInput
      ) {
        const workspaceRoot = normalizeWorkspaceRoot(input.workspaceRoot)
        const current = yield* Ref.get(state)
        const existingProject = current.projects.find(
          (project) =>
            normalizeWorkspaceRoot(project.workspaceRoot) === workspaceRoot
        )

        if (existingProject) {
          return existingProject
        }

        const project = {
          id: makeProjectId(crypto.randomUUID()),
          name: resolveProjectName(workspaceRoot),
          workspaceRoot,
          threads: [],
        } satisfies Project

        yield* Ref.set(state, {
          projects: [project, ...current.projects],
        })
        yield* publish({
          version: 1,
          type: 'projectAdded',
          payload: {
            project,
          },
        })

        return project
      })

      const createThread = Effect.fn('ProjectStore.createThread')(function* (
        input: ProjectsCreateThreadInput
      ) {
        const current = yield* Ref.get(state)
        const targetProject = current.projects.find(
          (project) => project.id === input.projectId
        )

        if (!targetProject) {
          return yield* new ProjectsCreateThreadError({
            message: 'Unable to create a thread for a missing project.',
          })
        }

        const thread = {
          id: makeThreadId(crypto.randomUUID()),
          title: 'New thread',
          updatedAt: new Date().toISOString(),
        } satisfies ProjectThread

        yield* Ref.set(state, {
          projects: current.projects.map((project) =>
            project.id === input.projectId
              ? {
                  ...project,
                  threads: [thread, ...project.threads],
                }
              : project
          ),
        })
        yield* publish({
          version: 1,
          type: 'threadAdded',
          payload: {
            projectId: input.projectId,
            thread,
          },
        })

        return thread
      })

      return ProjectStore.of({
        add,
        createThread,
        list: Ref.get(state),
        stream: Stream.fromPubSub(events),
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
  return name.length > 0 ? name : workspaceRoot
}
