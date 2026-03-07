import { Events, makeSchema, Schema, State } from '@livestore/livestore'
import { PanelNodeSchema, PrdStatus } from './types.js'

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const projects = State.SQLite.table({
  name: 'projects',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    repoPath: State.SQLite.text(),
    repoId: State.SQLite.text({ nullable: true }),
    canonicalGitCommonDir: State.SQLite.text({ nullable: true }),
    name: State.SQLite.text(),
    rlphConfig: State.SQLite.text({ nullable: true }),
  },
})

export const workspaces = State.SQLite.table({
  name: 'workspaces',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    taskSource: State.SQLite.text({ nullable: true }),
    branchName: State.SQLite.text(),
    worktreePath: State.SQLite.text(),
    port: State.SQLite.integer(),
    status: State.SQLite.text({ default: 'creating' }),
    origin: State.SQLite.text({ default: 'laborer' }),
    createdAt: State.SQLite.text(),
    /** SHA of the parent branch HEAD when the worktree was created. Used by DiffService as the base for `git diff`. */
    baseSha: State.SQLite.text({ nullable: true }),
    /** Docker container ID when a dev server container is running for this workspace. Null when no container exists. */
    containerId: State.SQLite.text({ nullable: true }),
    /** The `.orb.local` URL for the containerized dev server. Null when no container exists. */
    containerUrl: State.SQLite.text({ nullable: true }),
    /** The Docker image used for the container (e.g., `node:22`). Null when no container exists. */
    containerImage: State.SQLite.text({ nullable: true }),
    /** The current container status: 'running' or 'paused'. Null when no container exists. */
    containerStatus: State.SQLite.text({ nullable: true }),
  },
})

export const terminals = State.SQLite.table({
  name: 'terminals',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    workspaceId: State.SQLite.text(),
    command: State.SQLite.text(),
    status: State.SQLite.text({ default: 'running' }),
    ptySessionRef: State.SQLite.text({ nullable: true }),
  },
})

export const diffs = State.SQLite.table({
  name: 'diffs',
  columns: {
    workspaceId: State.SQLite.text({ primaryKey: true }),
    diffContent: State.SQLite.text({ default: '' }),
    lastUpdated: State.SQLite.text(),
  },
})

export const tasks = State.SQLite.table({
  name: 'tasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    source: State.SQLite.text(),
    prdId: State.SQLite.text({ nullable: true }),
    externalId: State.SQLite.text({ nullable: true }),
    title: State.SQLite.text(),
    status: State.SQLite.text({ default: 'pending' }),
  },
})

export const prds = State.SQLite.table({
  name: 'prds',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    title: State.SQLite.text(),
    slug: State.SQLite.text(),
    filePath: State.SQLite.text(),
    status: State.SQLite.text({ default: 'draft' }),
    createdAt: State.SQLite.text(),
  },
})

/**
 * PanelLayout stores the recursive tree structure of splits and panes.
 * Uses a single row per session (keyed by `id`) with the full tree serialized
 * as JSON. The `activePaneId` tracks which pane currently has focus.
 *
 * The `layoutTree` column uses `State.SQLite.json` which automatically handles
 * JSON serialization/deserialization via Effect Schema's `parseJson`.
 */
export const panelLayout = State.SQLite.table({
  name: 'panel_layout',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    layoutTree: State.SQLite.json({
      schema: PanelNodeSchema,
    }),
    activePaneId: State.SQLite.text({ nullable: true }),
  },
})

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const projectCreated = Events.synced({
  name: 'v1.ProjectCreated',
  schema: Schema.Struct({
    id: Schema.String,
    repoPath: Schema.String,
    repoId: Schema.optional(Schema.NullOr(Schema.String)),
    canonicalGitCommonDir: Schema.optional(Schema.NullOr(Schema.String)),
    name: Schema.String,
    rlphConfig: Schema.NullOr(Schema.String),
  }),
})

export const projectRepositoryIdentityBackfilled = Events.synced({
  name: 'v1.ProjectRepositoryIdentityBackfilled',
  schema: Schema.Struct({
    id: Schema.String,
    repoPath: Schema.String,
    repoId: Schema.String,
    canonicalGitCommonDir: Schema.String,
  }),
})

export const projectRemoved = Events.synced({
  name: 'v1.ProjectRemoved',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

export const workspaceCreated = Events.synced({
  name: 'v1.WorkspaceCreated',
  schema: Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    taskSource: Schema.NullOr(Schema.String),
    branchName: Schema.String,
    worktreePath: Schema.String,
    port: Schema.Number,
    status: Schema.String,
    origin: Schema.optionalWith(Schema.String, {
      default: () => 'laborer',
    }),
    createdAt: Schema.String,
    /** SHA of the parent branch HEAD when the worktree was created. Null for workspaces created before this field existed. */
    baseSha: Schema.optionalWith(Schema.NullOr(Schema.String), {
      default: () => null,
    }),
  }),
})

export const workspaceStatusChanged = Events.synced({
  name: 'v1.WorkspaceStatusChanged',
  schema: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
  }),
})

export const workspaceBranchChanged = Events.synced({
  name: 'v1.WorkspaceBranchChanged',
  schema: Schema.Struct({
    id: Schema.String,
    branchName: Schema.String,
  }),
})

export const workspaceDestroyed = Events.synced({
  name: 'v1.WorkspaceDestroyed',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

export const containerStarted = Events.synced({
  name: 'v1.ContainerStarted',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    containerId: Schema.String,
    containerUrl: Schema.String,
    containerImage: Schema.String,
  }),
})

export const containerStopped = Events.synced({
  name: 'v1.ContainerStopped',
  schema: Schema.Struct({
    workspaceId: Schema.String,
  }),
})

export const containerPaused = Events.synced({
  name: 'v1.ContainerPaused',
  schema: Schema.Struct({
    workspaceId: Schema.String,
  }),
})

export const containerUnpaused = Events.synced({
  name: 'v1.ContainerUnpaused',
  schema: Schema.Struct({
    workspaceId: Schema.String,
  }),
})

export const terminalSpawned = Events.synced({
  name: 'v1.TerminalSpawned',
  schema: Schema.Struct({
    id: Schema.String,
    workspaceId: Schema.String,
    command: Schema.String,
    status: Schema.String,
    ptySessionRef: Schema.NullOr(Schema.String),
  }),
})

/**
 * @deprecated Issue #143 — Terminal output now flows exclusively through the
 * dedicated WebSocket channel (Issue #139/#140). This event is no longer
 * committed by TerminalManager. The definition is retained for backward
 * compatibility with existing eventlog data (the no-op materializer `() => []`
 * ensures old events don't break materialization).
 */
export const terminalOutput = Events.synced({
  name: 'v1.TerminalOutput',
  schema: Schema.Struct({
    id: Schema.String,
    data: Schema.String,
  }),
})

export const terminalStatusChanged = Events.synced({
  name: 'v1.TerminalStatusChanged',
  schema: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
  }),
})

export const terminalKilled = Events.synced({
  name: 'v1.TerminalKilled',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

export const terminalRemoved = Events.synced({
  name: 'v1.TerminalRemoved',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

export const terminalRestarted = Events.synced({
  name: 'v1.TerminalRestarted',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

export const diffUpdated = Events.synced({
  name: 'v1.DiffUpdated',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    diffContent: Schema.String,
    lastUpdated: Schema.String,
  }),
})

export const diffCleared = Events.synced({
  name: 'v1.DiffCleared',
  schema: Schema.Struct({
    workspaceId: Schema.String,
  }),
})

export const taskCreated = Events.synced({
  name: 'v1.TaskCreated',
  schema: Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    source: Schema.String,
    prdId: Schema.optionalWith(Schema.NullOr(Schema.String), {
      default: () => null,
    }),
    externalId: Schema.NullOr(Schema.String),
    title: Schema.String,
    status: Schema.String,
  }),
})

export const taskStatusChanged = Events.synced({
  name: 'v1.TaskStatusChanged',
  schema: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
  }),
})

export const taskRemoved = Events.synced({
  name: 'v1.TaskRemoved',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

export const prdCreated = Events.synced({
  name: 'v1.PrdCreated',
  schema: Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    title: Schema.String,
    slug: Schema.String,
    filePath: Schema.String,
    status: Schema.optionalWith(PrdStatus, {
      default: () => 'draft',
    }),
    createdAt: Schema.String,
  }),
})

export const prdStatusChanged = Events.synced({
  name: 'v1.PrdStatusChanged',
  schema: Schema.Struct({
    id: Schema.String,
    status: PrdStatus,
  }),
})

export const prdUpdated = Events.synced({
  name: 'v1.PrdUpdated',
  schema: Schema.Struct({
    id: Schema.String,
    projectId: Schema.String,
    title: Schema.String,
    slug: Schema.String,
    filePath: Schema.String,
    status: PrdStatus,
    createdAt: Schema.String,
  }),
})

export const prdRemoved = Events.synced({
  name: 'v1.PrdRemoved',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

// -- Panel Layout events ----------------------------------------------------

/**
 * All panel layout events carry the full updated layout tree and active pane.
 * Tree manipulation logic lives in the app; the materializer simply persists
 * the result. Each event represents a different user action for auditability.
 */

const layoutEventSchema = Schema.Struct({
  id: Schema.String,
  layoutTree: PanelNodeSchema,
  activePaneId: Schema.NullOr(Schema.String),
})

export const layoutSplit = Events.synced({
  name: 'v1.LayoutSplit',
  schema: layoutEventSchema,
})

export const layoutPaneClosed = Events.synced({
  name: 'v1.LayoutPaneClosed',
  schema: layoutEventSchema,
})

export const layoutPaneAssigned = Events.synced({
  name: 'v1.LayoutPaneAssigned',
  schema: layoutEventSchema,
})

export const layoutRestored = Events.synced({
  name: 'v1.LayoutRestored',
  schema: layoutEventSchema,
})

export const events = {
  projectCreated,
  projectRepositoryIdentityBackfilled,
  projectRemoved,
  workspaceCreated,
  workspaceStatusChanged,
  workspaceBranchChanged,
  workspaceDestroyed,
  containerStarted,
  containerStopped,
  containerPaused,
  containerUnpaused,
  terminalSpawned,
  terminalOutput,
  terminalStatusChanged,
  terminalKilled,
  terminalRemoved,
  terminalRestarted,
  diffUpdated,
  diffCleared,
  taskCreated,
  taskStatusChanged,
  taskRemoved,
  prdCreated,
  prdUpdated,
  prdStatusChanged,
  prdRemoved,
  layoutSplit,
  layoutPaneClosed,
  layoutPaneAssigned,
  layoutRestored,
}

// ---------------------------------------------------------------------------
// Materializers
// ---------------------------------------------------------------------------

const materializers = State.SQLite.materializers(events, {
  'v1.ProjectCreated': ({
    id,
    repoPath,
    repoId,
    canonicalGitCommonDir,
    name,
    rlphConfig,
  }) =>
    projects.insert({
      id,
      repoPath,
      repoId: repoId ?? null,
      canonicalGitCommonDir: canonicalGitCommonDir ?? null,
      name,
      rlphConfig,
    }),
  'v1.ProjectRepositoryIdentityBackfilled': ({
    id,
    repoPath,
    repoId,
    canonicalGitCommonDir,
  }) =>
    projects
      .update({
        repoPath,
        repoId,
        canonicalGitCommonDir,
      })
      .where({ id }),
  'v1.ProjectRemoved': ({ id }) => projects.delete().where({ id }),
  'v1.WorkspaceCreated': ({
    id,
    projectId,
    taskSource,
    branchName,
    worktreePath,
    port,
    status,
    origin,
    createdAt,
    baseSha,
  }) =>
    workspaces.insert({
      id,
      projectId,
      taskSource,
      branchName,
      worktreePath,
      port,
      status,
      origin,
      createdAt,
      baseSha,
      containerId: null,
      containerUrl: null,
      containerImage: null,
      containerStatus: null,
    }),
  'v1.WorkspaceStatusChanged': ({ id, status }) =>
    workspaces.update({ status }).where({ id }),
  'v1.WorkspaceBranchChanged': ({ id, branchName }) =>
    workspaces.update({ branchName }).where({ id }),
  'v1.WorkspaceDestroyed': ({ id }) => workspaces.delete().where({ id }),
  'v1.ContainerStarted': ({
    workspaceId,
    containerId,
    containerUrl,
    containerImage,
  }) =>
    workspaces
      .update({
        containerId,
        containerUrl,
        containerImage,
        containerStatus: 'running',
      })
      .where({ id: workspaceId }),
  'v1.ContainerStopped': ({ workspaceId }) =>
    workspaces
      .update({
        containerId: null,
        containerUrl: null,
        containerImage: null,
        containerStatus: null,
      })
      .where({ id: workspaceId }),
  'v1.ContainerPaused': ({ workspaceId }) =>
    workspaces.update({ containerStatus: 'paused' }).where({ id: workspaceId }),
  'v1.ContainerUnpaused': ({ workspaceId }) =>
    workspaces
      .update({ containerStatus: 'running' })
      .where({ id: workspaceId }),
  'v1.TerminalSpawned': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalOutput': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #143)
  'v1.TerminalStatusChanged': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalKilled': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalRemoved': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalRestarted': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.DiffUpdated': ({ workspaceId, diffContent, lastUpdated }) =>
    diffs
      .insert({ workspaceId, diffContent, lastUpdated })
      .onConflict('workspaceId', 'replace'),
  'v1.DiffCleared': ({ workspaceId }) => diffs.delete().where({ workspaceId }),
  'v1.TaskCreated': ({
    id,
    projectId,
    source,
    prdId,
    externalId,
    title,
    status,
  }) =>
    tasks.insert({
      id,
      projectId,
      source,
      prdId,
      externalId,
      title,
      status,
    }),
  'v1.TaskStatusChanged': ({ id, status }) =>
    tasks.update({ status }).where({ id }),
  'v1.TaskRemoved': ({ id }) => tasks.delete().where({ id }),
  'v1.PrdCreated': ({
    id,
    projectId,
    title,
    slug,
    filePath,
    status,
    createdAt,
  }) =>
    prds.insert({
      id,
      projectId,
      title,
      slug,
      filePath,
      status,
      createdAt,
    }),
  'v1.PrdUpdated': ({
    id,
    projectId,
    title,
    slug,
    filePath,
    status,
    createdAt,
  }) =>
    prds
      .update({
        projectId,
        title,
        slug,
        filePath,
        status,
        createdAt,
      })
      .where({ id }),
  'v1.PrdStatusChanged': ({ id, status }) =>
    prds.update({ status }).where({ id }),
  'v1.PrdRemoved': ({ id }) => prds.delete().where({ id }),
  'v1.LayoutSplit': ({ id, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ id, layoutTree, activePaneId })
      .onConflict('id', 'replace'),
  'v1.LayoutPaneClosed': ({ id, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ id, layoutTree, activePaneId })
      .onConflict('id', 'replace'),
  'v1.LayoutPaneAssigned': ({ id, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ id, layoutTree, activePaneId })
      .onConflict('id', 'replace'),
  'v1.LayoutRestored': ({ id, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ id, layoutTree, activePaneId })
      .onConflict('id', 'replace'),
})

// ---------------------------------------------------------------------------
// Tables export
// ---------------------------------------------------------------------------

export const tables = {
  projects,
  workspaces,
  terminals,
  diffs,
  tasks,
  prds,
  panelLayout,
}

/**
 * Active schema tables (Issue #145): terminal state moved out of LiveStore.
 * Keep the legacy `terminals` table definition exported for backward
 * compatibility in tests/older modules, but do not register it in the active
 * LiveStore state.
 */
const activeTables = {
  projects,
  workspaces,
  diffs,
  tasks,
  prds,
  panelLayout,
}

// ---------------------------------------------------------------------------
// State & Schema
// ---------------------------------------------------------------------------

const state = State.SQLite.makeState({ tables: activeTables, materializers })

export const schema = makeSchema({ events, state })
