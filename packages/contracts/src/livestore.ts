import { Events, makeSchema, State } from '@livestore/livestore'
import { Schema } from 'effect'

import {
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from './base'
import {
  Project,
  ProjectsSnapshot,
  ProjectWorkspace,
  WorkspaceName,
} from './projects'

export const PROJECTS_LIVESTORE_ID = 'laborer-projects-v2'

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
  projectWorkspaces: State.SQLite.table({
    name: 'project_workspaces',
    columns: {
      id: State.SQLite.text({ primaryKey: true, schema: WorkspaceId }),
      projectId: State.SQLite.text({ schema: ProjectId }),
      name: State.SQLite.text({ schema: WorkspaceName }),
      workspaceRoot: State.SQLite.text({ schema: TrimmedNonEmptyString }),
      updatedAt: State.SQLite.text({ schema: IsoDateTime }),
      sortOrder: State.SQLite.integer({ default: 0 }),
    },
  }),
}

export type ProjectStoreProjectRow =
  typeof projectStoreTables.projects.rowSchema.Type
export type ProjectStoreProjectWorkspaceRow =
  typeof projectStoreTables.projectWorkspaces.rowSchema.Type

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
  workspaceAdded: Events.synced({
    name: 'v1.ProjectWorkspaceAdded',
    schema: Schema.Struct({
      projectId: ProjectId,
      workspace: ProjectWorkspace,
      sortOrder: Schema.Int,
    }),
  }),
}

const materializers = State.SQLite.materializers(projectStoreEvents, {
  'v1.ProjectsSnapshotReplaced': ({ snapshot }) => [
    projectStoreTables.projectWorkspaces.delete(),
    projectStoreTables.projects.delete(),
    ...snapshot.projects.flatMap((project, projectIndex) => [
      projectStoreTables.projects.insert(toProjectRow(project, projectIndex)),
      ...project.workspaces.map((workspace, workspaceIndex) =>
        projectStoreTables.projectWorkspaces.insert(
          toProjectWorkspaceRow(project.id, workspace, workspaceIndex)
        )
      ),
    ]),
  ],
  'v1.ProjectAdded': ({ project, sortOrder }) => [
    projectStoreTables.projects.insert(toProjectRow(project, sortOrder)),
    ...project.workspaces.map((workspace, workspaceIndex) =>
      projectStoreTables.projectWorkspaces.insert(
        toProjectWorkspaceRow(project.id, workspace, workspaceIndex)
      )
    ),
  ],
  'v1.ProjectWorkspaceAdded': ({ projectId, workspace, sortOrder }) =>
    projectStoreTables.projectWorkspaces.insert(
      toProjectWorkspaceRow(projectId, workspace, sortOrder)
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
  workspaceRows: readonly ProjectStoreProjectWorkspaceRow[]
): ProjectsSnapshot => {
  const workspacesByProjectId = new Map<
    ProjectStoreProjectWorkspaceRow['projectId'],
    ProjectWorkspace[]
  >()

  for (const workspaceRow of sortProjectWorkspaceRows(workspaceRows)) {
    const workspaces = workspacesByProjectId.get(workspaceRow.projectId) ?? []
    workspaces.push({
      id: workspaceRow.id,
      name: workspaceRow.name,
      workspaceRoot: workspaceRow.workspaceRoot,
      updatedAt: workspaceRow.updatedAt,
    })
    workspacesByProjectId.set(workspaceRow.projectId, workspaces)
  }

  return {
    projects: sortProjectRows(projectRows).map((projectRow) => ({
      id: projectRow.id,
      name: projectRow.name,
      workspaceRoot: projectRow.workspaceRoot,
      workspaces: workspacesByProjectId.get(projectRow.id) ?? [],
    })),
  }
}

const toProjectRow = (project: Project, sortOrder: number) => ({
  id: project.id,
  name: project.name,
  workspaceRoot: project.workspaceRoot,
  sortOrder,
})

const toProjectWorkspaceRow = (
  projectId: ProjectStoreProjectWorkspaceRow['projectId'],
  workspace: ProjectWorkspace,
  sortOrder: number
) => ({
  id: workspace.id,
  projectId,
  name: workspace.name,
  workspaceRoot: workspace.workspaceRoot,
  updatedAt: workspace.updatedAt,
  sortOrder,
})

const sortProjectRows = (
  projectRows: readonly ProjectStoreProjectRow[]
): ProjectStoreProjectRow[] =>
  [...projectRows].sort((left, right) => left.sortOrder - right.sortOrder)

const sortProjectWorkspaceRows = (
  workspaceRows: readonly ProjectStoreProjectWorkspaceRow[]
): ProjectStoreProjectWorkspaceRow[] =>
  [...workspaceRows].sort((left, right) => left.sortOrder - right.sortOrder)
