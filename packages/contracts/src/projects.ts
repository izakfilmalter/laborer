import { Schema } from 'effect'

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from './base'

export const ProjectThread = Schema.Struct({
  id: ThreadId,
  title: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
})
export type ProjectThread = typeof ProjectThread.Type

export const Project = Schema.Struct({
  id: ProjectId,
  name: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  threads: Schema.Array(ProjectThread),
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

export const ProjectsCreateThreadInput = Schema.Struct({
  projectId: ProjectId,
})
export type ProjectsCreateThreadInput = typeof ProjectsCreateThreadInput.Type

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

export const ProjectsEventThreadAdded = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal('threadAdded'),
  payload: Schema.Struct({
    projectId: ProjectId,
    thread: ProjectThread,
  }),
})
export type ProjectsEventThreadAdded = typeof ProjectsEventThreadAdded.Type

export const ProjectsEvent = Schema.Union([
  ProjectsEventSnapshot,
  ProjectsEventProjectAdded,
  ProjectsEventThreadAdded,
])
export type ProjectsEvent = typeof ProjectsEvent.Type

export class ProjectsCreateThreadError extends Schema.TaggedErrorClass<ProjectsCreateThreadError>()(
  'ProjectsCreateThreadError',
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  }
) {}
