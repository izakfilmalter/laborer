import { Schema } from 'effect'

import {
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from './base'

const WorkspaceNamePattern =
  /^[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?(?:\/[a-z0-9]+(?:[a-z0-9_-]*[a-z0-9])?)*$/

export const WorkspaceName = TrimmedNonEmptyString.pipe(
  Schema.pattern(WorkspaceNamePattern)
)
export type WorkspaceName = typeof WorkspaceName.Type

export const ProjectWorkspace = Schema.Struct({
  id: WorkspaceId,
  name: WorkspaceName,
  workspaceRoot: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
})
export type ProjectWorkspace = typeof ProjectWorkspace.Type

export const Project = Schema.Struct({
  id: ProjectId,
  name: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  workspaces: Schema.Array(ProjectWorkspace),
})
export type Project = typeof Project.Type

export const ProjectsSnapshot = Schema.Struct({
  projects: Schema.Array(Project),
})
export type ProjectsSnapshot = typeof ProjectsSnapshot.Type

export const ProjectsAddInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
})
export type ProjectsAddInput = typeof ProjectsAddInput.Type

export const ProjectsCreateWorkspaceInput = Schema.Struct({
  projectId: ProjectId,
  name: WorkspaceName,
})
export type ProjectsCreateWorkspaceInput =
  typeof ProjectsCreateWorkspaceInput.Type

export const ProjectsEventSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal('snapshot'),
  snapshot: ProjectsSnapshot,
})
export type ProjectsEventSnapshot = typeof ProjectsEventSnapshot.Type

export const ProjectsEventProjectAdded = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal('projectAdded'),
  payload: Schema.Struct({
    project: Project,
  }),
})
export type ProjectsEventProjectAdded = typeof ProjectsEventProjectAdded.Type

export const ProjectsEventWorkspaceAdded = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal('workspaceAdded'),
  payload: Schema.Struct({
    projectId: ProjectId,
    workspace: ProjectWorkspace,
  }),
})
export type ProjectsEventWorkspaceAdded =
  typeof ProjectsEventWorkspaceAdded.Type

export const ProjectsEvent = Schema.Union(
  ProjectsEventSnapshot,
  ProjectsEventProjectAdded,
  ProjectsEventWorkspaceAdded
)
export type ProjectsEvent = typeof ProjectsEvent.Type

export class ProjectsCreateWorkspaceError extends Schema.TaggedError<ProjectsCreateWorkspaceError>()(
  'ProjectsCreateWorkspaceError',
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  }
) {}
