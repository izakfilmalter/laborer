import { Events, makeSchema, State } from '@livestore/livestore'
import { Schema } from 'effect'

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from './base'
import { Project, ProjectsSnapshot, ProjectThread } from './projects'

export const PROJECTS_LIVESTORE_ID = 'laborer-projects'

export const projectStoreTables = {
  projects: State.SQLite.table({
    name: 'projects',
    columns: {
      id: State.SQLite.text({ primaryKey: true, schema: ProjectId }),
      name: State.SQLite.text({ schema: TrimmedNonEmptyString }),
      workspaceRoot: State.SQLite.text({ schema: TrimmedNonEmptyString }),
      sortOrder: State.SQLite.integer({ default: 0 }),
    },
  }),
  projectThreads: State.SQLite.table({
    name: 'project_threads',
    columns: {
      id: State.SQLite.text({ primaryKey: true, schema: ThreadId }),
      projectId: State.SQLite.text({ schema: ProjectId }),
      title: State.SQLite.text({ schema: TrimmedNonEmptyString }),
      updatedAt: State.SQLite.text({ schema: IsoDateTime }),
      sortOrder: State.SQLite.integer({ default: 0 }),
    },
  }),
}

export type ProjectStoreProjectRow =
  typeof projectStoreTables.projects.rowSchema.Type
export type ProjectStoreProjectThreadRow =
  typeof projectStoreTables.projectThreads.rowSchema.Type

export const projectStoreEvents = {
  snapshotReplaced: Events.synced({
    name: 'v1.ProjectsSnapshotReplaced',
    schema: Schema.Struct({
      snapshot: ProjectsSnapshot,
    }),
  }),
  projectAdded: Events.synced({
    name: 'v1.ProjectAdded',
    schema: Schema.Struct({
      project: Project,
      sortOrder: Schema.Int,
    }),
  }),
  threadAdded: Events.synced({
    name: 'v1.ProjectThreadAdded',
    schema: Schema.Struct({
      projectId: ProjectId,
      thread: ProjectThread,
      sortOrder: Schema.Int,
    }),
  }),
}

const materializers = State.SQLite.materializers(projectStoreEvents, {
  'v1.ProjectsSnapshotReplaced': ({ snapshot }) => [
    projectStoreTables.projectThreads.delete(),
    projectStoreTables.projects.delete(),
    ...snapshot.projects.flatMap((project, projectIndex) => [
      projectStoreTables.projects.insert(toProjectRow(project, projectIndex)),
      ...project.threads.map((thread, threadIndex) =>
        projectStoreTables.projectThreads.insert(
          toProjectThreadRow(project.id, thread, threadIndex)
        )
      ),
    ]),
  ],
  'v1.ProjectAdded': ({ project, sortOrder }) => [
    projectStoreTables.projects.insert(toProjectRow(project, sortOrder)),
    ...project.threads.map((thread, threadIndex) =>
      projectStoreTables.projectThreads.insert(
        toProjectThreadRow(project.id, thread, threadIndex)
      )
    ),
  ],
  'v1.ProjectThreadAdded': ({ projectId, thread, sortOrder }) =>
    projectStoreTables.projectThreads.insert(
      toProjectThreadRow(projectId, thread, sortOrder)
    ),
})

const state = State.SQLite.makeState({
  tables: projectStoreTables,
  materializers,
})

export const projectStoreSchema = makeSchema({
  events: projectStoreEvents,
  state,
})

export const buildProjectsSnapshot = (
  projectRows: readonly ProjectStoreProjectRow[],
  threadRows: readonly ProjectStoreProjectThreadRow[]
): ProjectsSnapshot => {
  const threadsByProjectId = new Map<
    ProjectStoreProjectThreadRow['projectId'],
    ProjectThread[]
  >()

  for (const threadRow of sortProjectThreadRows(threadRows)) {
    const threads = threadsByProjectId.get(threadRow.projectId) ?? []
    threads.push({
      id: threadRow.id,
      title: threadRow.title,
      updatedAt: threadRow.updatedAt,
    })
    threadsByProjectId.set(threadRow.projectId, threads)
  }

  return {
    projects: sortProjectRows(projectRows).map((projectRow) => ({
      id: projectRow.id,
      name: projectRow.name,
      workspaceRoot: projectRow.workspaceRoot,
      threads: threadsByProjectId.get(projectRow.id) ?? [],
    })),
  }
}

const toProjectRow = (project: Project, sortOrder: number) => ({
  id: project.id,
  name: project.name,
  workspaceRoot: project.workspaceRoot,
  sortOrder,
})

const toProjectThreadRow = (
  projectId: ProjectStoreProjectThreadRow['projectId'],
  thread: ProjectThread,
  sortOrder: number
) => ({
  id: thread.id,
  projectId,
  title: thread.title,
  updatedAt: thread.updatedAt,
  sortOrder,
})

const sortProjectRows = (
  projectRows: readonly ProjectStoreProjectRow[]
): ProjectStoreProjectRow[] =>
  [...projectRows].sort((left, right) => left.sortOrder - right.sortOrder)

const sortProjectThreadRows = (
  threadRows: readonly ProjectStoreProjectThreadRow[]
): ProjectStoreProjectThreadRow[] =>
  [...threadRows].sort((left, right) => left.sortOrder - right.sortOrder)
