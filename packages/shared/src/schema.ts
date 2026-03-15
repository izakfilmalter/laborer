import { Events, makeSchema, Schema, State } from '@livestore/livestore'
import { PanelNodeSchema, PrdStatus, WindowLayoutSchema } from './types.js'

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
    brrrConfig: State.SQLite.text({ nullable: true }),
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
    /** Current step of the background container setup process. Null when setup is complete or not started. */
    containerSetupStep: State.SQLite.text({ nullable: true }),
    /** Current step of the background worktree setup process (git fetch, worktree add, setup scripts). Null when setup is complete or not started. */
    worktreeSetupStep: State.SQLite.text({ nullable: true }),
    /** Pull request number associated with this workspace's branch. Null when no PR exists. */
    prNumber: State.SQLite.integer({ nullable: true }),
    /** Full URL to the pull request on GitHub. Null when no PR exists. */
    prUrl: State.SQLite.text({ nullable: true }),
    /** Pull request title. Null when no PR exists. */
    prTitle: State.SQLite.text({ nullable: true }),
    /** Pull request state: 'OPEN', 'CLOSED', 'MERGED'. Null when no PR exists. */
    prState: State.SQLite.text({ nullable: true }),
    /** Number of local commits ahead of upstream. Null when no upstream is configured. */
    aheadCount: State.SQLite.integer({ nullable: true }),
    /** Number of upstream commits not yet pulled locally. Null when no upstream is configured. */
    behindCount: State.SQLite.integer({ nullable: true }),
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
 * Global application settings stored as key-value pairs.
 * Used for configuration that applies across all projects/workspaces,
 * such as the GitHub Desktop OAuth token for Alive real-time notifications.
 */
export const appSettings = State.SQLite.table({
  name: 'app_settings',
  columns: {
    key: State.SQLite.text({ primaryKey: true }),
    value: State.SQLite.text(),
  },
})

/**
 * PanelLayout stores the recursive tree structure of splits and panes.
 * Uses a single row per window session (keyed by `windowId`) with the full
 * tree serialized as JSON.
 *
 * Legacy columns (`layoutTree`, `activePaneId`, `workspaceOrder`) store the
 * old flat `PanelNode` format. New columns (`windowLayout`, `activeWindowTabId`)
 * store the hierarchical `WindowLayout` format. During migration both may
 * coexist; consumers should prefer `windowLayout` when present.
 */
export const panelLayout = State.SQLite.table({
  name: 'panel_layout',
  columns: {
    windowId: State.SQLite.text({ primaryKey: true }),
    /** @deprecated — Legacy flat layout tree. Use `windowLayout` for new code. */
    layoutTree: State.SQLite.json({
      schema: Schema.NullOr(PanelNodeSchema),
      nullable: true,
      default: null,
    }),
    /** @deprecated — Legacy active pane ID. Focus state is now embedded in `windowLayout`. */
    activePaneId: State.SQLite.text({ nullable: true }),
    /**
     * @deprecated — Legacy workspace ordering. Now embedded in `windowLayout`'s
     * workspace tile tree.
     */
    workspaceOrder: State.SQLite.json({
      schema: Schema.NullOr(Schema.Array(Schema.String)),
      nullable: true,
      default: null,
    }),
    /**
     * The hierarchical layout tree: WindowLayout > WindowTab > WorkspaceTileNode > PanelTab.
     * Contains all window tabs, workspace tiling, panel tabs, and split trees.
     * Null when the row was written by legacy events that only populated `layoutTree`.
     */
    windowLayout: State.SQLite.json({
      schema: Schema.NullOr(WindowLayoutSchema),
      nullable: true,
      default: null,
    }),
    /**
     * ID of the currently active window tab within this Electron window.
     * Null when using legacy layout format or when no tab is active.
     */
    activeWindowTabId: State.SQLite.text({ nullable: true }),
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
    brrrConfig: Schema.optional(Schema.NullOr(Schema.String)),
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

export const workspaceBaseShaUpdated = Events.synced({
  name: 'v1.WorkspaceBaseShaUpdated',
  schema: Schema.Struct({
    id: Schema.String,
    baseSha: Schema.NullOr(Schema.String),
  }),
})

export const workspaceDestroyed = Events.synced({
  name: 'v1.WorkspaceDestroyed',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

export const workspacePrUpdated = Events.synced({
  name: 'v1.WorkspacePrUpdated',
  schema: Schema.Struct({
    id: Schema.String,
    prNumber: Schema.NullOr(Schema.Number),
    prUrl: Schema.NullOr(Schema.String),
    prTitle: Schema.NullOr(Schema.String),
    prState: Schema.NullOr(Schema.String),
  }),
})

export const workspaceSyncStatusUpdated = Events.synced({
  name: 'v1.WorkspaceSyncStatusUpdated',
  schema: Schema.Struct({
    id: Schema.String,
    aheadCount: Schema.NullOr(Schema.Number),
    behindCount: Schema.NullOr(Schema.Number),
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

export const containerSetupStepChanged = Events.synced({
  name: 'v1.ContainerSetupStepChanged',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    /** Current setup step, or null when setup is complete. */
    step: Schema.NullOr(Schema.String),
  }),
})

export const worktreeSetupStepChanged = Events.synced({
  name: 'v1.WorktreeSetupStepChanged',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    /** Current worktree setup step, or null when setup is complete. */
    step: Schema.NullOr(Schema.String),
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

// -- App Settings events ----------------------------------------------------

export const appSettingChanged = Events.synced({
  name: 'v1.AppSettingChanged',
  schema: Schema.Struct({
    key: Schema.String,
    value: Schema.String,
  }),
})

// -- Panel Layout events ----------------------------------------------------

/**
 * All panel layout events carry the full updated layout tree and active pane.
 * Tree manipulation logic lives in the app; the materializer simply persists
 * the result. Each event represents a different user action for auditability.
 */

const layoutEventSchema = Schema.Struct({
  windowId: Schema.String,
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

/**
 * Fired when the user reorders workspace frames via drag-and-drop.
 * Persists the new workspace ordering alongside the existing layout tree.
 */
export const layoutWorkspacesReordered = Events.synced({
  name: 'v1.LayoutWorkspacesReordered',
  schema: Schema.Struct({
    windowId: Schema.String,
    workspaceOrder: Schema.Array(Schema.String),
  }),
})

// -- Hierarchical Layout events ---------------------------------------------

/**
 * All hierarchical layout events carry the full `WindowLayout` tree for the
 * window. Tree manipulation logic lives in the app; the materializer simply
 * persists the result. Each event represents a different user action for
 * auditability.
 *
 * The `activeWindowTabId` is stored as a top-level column for quick access
 * without deserializing the full JSON tree.
 */

const windowLayoutEventSchema = Schema.Struct({
  windowId: Schema.String,
  windowLayout: WindowLayoutSchema,
  activeWindowTabId: Schema.NullOr(Schema.String),
})

/** Fired when a new window tab is created (e.g., Cmd+N). */
export const windowTabCreated = Events.synced({
  name: 'v1.WindowTabCreated',
  schema: windowLayoutEventSchema,
})

/** Fired when a window tab is closed (e.g., Cmd+Shift+W). */
export const windowTabClosed = Events.synced({
  name: 'v1.WindowTabClosed',
  schema: windowLayoutEventSchema,
})

/** Fired when the user switches to a different window tab. */
export const windowTabSwitched = Events.synced({
  name: 'v1.WindowTabSwitched',
  schema: windowLayoutEventSchema,
})

/** Fired when window tabs are reordered via drag-and-drop. */
export const windowTabsReordered = Events.synced({
  name: 'v1.WindowTabsReordered',
  schema: windowLayoutEventSchema,
})

/** Fired when a new panel tab is created within a workspace (e.g., Ctrl+T). */
export const panelTabCreated = Events.synced({
  name: 'v1.PanelTabCreated',
  schema: windowLayoutEventSchema,
})

/** Fired when a panel tab is closed within a workspace. */
export const panelTabClosed = Events.synced({
  name: 'v1.PanelTabClosed',
  schema: windowLayoutEventSchema,
})

/** Fired when the user switches to a different panel tab within a workspace. */
export const panelTabSwitched = Events.synced({
  name: 'v1.PanelTabSwitched',
  schema: windowLayoutEventSchema,
})

/** Fired when panel tabs are reordered within a workspace via drag-and-drop. */
export const panelTabsReordered = Events.synced({
  name: 'v1.PanelTabsReordered',
  schema: windowLayoutEventSchema,
})

/**
 * Fired when the hierarchical layout is restored on startup (new format).
 * Used for both initial seeding and post-reconciliation commits.
 */
export const windowLayoutRestored = Events.synced({
  name: 'v1.WindowLayoutRestored',
  schema: windowLayoutEventSchema,
})

/**
 * Fired when a pane is split within the hierarchical layout (new format).
 * Carries the full updated WindowLayout tree.
 */
export const windowLayoutSplit = Events.synced({
  name: 'v1.WindowLayoutSplit',
  schema: windowLayoutEventSchema,
})

/**
 * Fired when a pane is closed within the hierarchical layout (new format).
 * Carries the full updated WindowLayout tree.
 */
export const windowLayoutPaneClosed = Events.synced({
  name: 'v1.WindowLayoutPaneClosed',
  schema: windowLayoutEventSchema,
})

/**
 * Fired when a pane is assigned (focus change, terminal assignment) in the
 * hierarchical layout. Carries the full updated WindowLayout tree.
 */
export const windowLayoutPaneAssigned = Events.synced({
  name: 'v1.WindowLayoutPaneAssigned',
  schema: windowLayoutEventSchema,
})

export const events = {
  projectCreated,
  projectRepositoryIdentityBackfilled,
  projectRemoved,
  workspaceCreated,
  workspaceStatusChanged,
  workspaceBranchChanged,
  workspaceBaseShaUpdated,
  workspaceDestroyed,
  workspacePrUpdated,
  workspaceSyncStatusUpdated,
  containerStarted,
  containerStopped,
  containerPaused,
  containerUnpaused,
  containerSetupStepChanged,
  worktreeSetupStepChanged,
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
  appSettingChanged,
  layoutSplit,
  layoutPaneClosed,
  layoutPaneAssigned,
  layoutRestored,
  layoutWorkspacesReordered,
  windowTabCreated,
  windowTabClosed,
  windowTabSwitched,
  windowTabsReordered,
  panelTabCreated,
  panelTabClosed,
  panelTabSwitched,
  panelTabsReordered,
  windowLayoutRestored,
  windowLayoutSplit,
  windowLayoutPaneClosed,
  windowLayoutPaneAssigned,
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
    brrrConfig,
  }) =>
    projects.insert({
      id,
      repoPath,
      repoId: repoId ?? null,
      canonicalGitCommonDir: canonicalGitCommonDir ?? null,
      name,
      brrrConfig: brrrConfig ?? null,
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
      containerSetupStep: null,
      worktreeSetupStep: null,
      prNumber: null,
      prUrl: null,
      prTitle: null,
      prState: null,
      aheadCount: null,
      behindCount: null,
    }),
  'v1.WorkspaceStatusChanged': ({ id, status }) =>
    status === 'running'
      ? workspaces.update({ status, worktreeSetupStep: null }).where({ id })
      : workspaces.update({ status }).where({ id }),
  'v1.WorkspaceBranchChanged': ({ id, branchName }) =>
    workspaces.update({ branchName }).where({ id }),
  'v1.WorkspaceBaseShaUpdated': ({ id, baseSha }) =>
    workspaces.update({ baseSha }).where({ id }),
  'v1.WorkspaceDestroyed': ({ id }) => workspaces.delete().where({ id }),
  'v1.WorkspacePrUpdated': ({ id, prNumber, prUrl, prTitle, prState }) =>
    workspaces.update({ prNumber, prUrl, prTitle, prState }).where({ id }),
  'v1.WorkspaceSyncStatusUpdated': ({ id, aheadCount, behindCount }) =>
    workspaces.update({ aheadCount, behindCount }).where({ id }),
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
        containerSetupStep: null,
      })
      .where({ id: workspaceId }),
  'v1.ContainerStopped': ({ workspaceId }) =>
    workspaces
      .update({
        containerId: null,
        containerStatus: null,
        containerSetupStep: null,
      })
      .where({ id: workspaceId }),
  'v1.ContainerPaused': ({ workspaceId }) =>
    workspaces.update({ containerStatus: 'paused' }).where({ id: workspaceId }),
  'v1.ContainerUnpaused': ({ workspaceId }) =>
    workspaces
      .update({ containerStatus: 'running' })
      .where({ id: workspaceId }),
  'v1.ContainerSetupStepChanged': ({ workspaceId, step }) =>
    workspaces.update({ containerSetupStep: step }).where({ id: workspaceId }),
  'v1.WorktreeSetupStepChanged': ({ workspaceId, step }) =>
    workspaces.update({ worktreeSetupStep: step }).where({ id: workspaceId }),
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
  'v1.AppSettingChanged': ({ key, value }) =>
    appSettings.insert({ key, value }).onConflict('key', 'replace'),
  'v1.LayoutSplit': ({ windowId, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ windowId, layoutTree, activePaneId })
      .onConflict('windowId', 'update', { layoutTree, activePaneId }),
  'v1.LayoutPaneClosed': ({ windowId, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ windowId, layoutTree, activePaneId })
      .onConflict('windowId', 'update', { layoutTree, activePaneId }),
  'v1.LayoutPaneAssigned': ({ windowId, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ windowId, layoutTree, activePaneId })
      .onConflict('windowId', 'update', { layoutTree, activePaneId }),
  'v1.LayoutRestored': ({ windowId, layoutTree, activePaneId }) =>
    panelLayout
      .insert({ windowId, layoutTree, activePaneId })
      .onConflict('windowId', 'update', { layoutTree, activePaneId }),
  'v1.LayoutWorkspacesReordered': ({ windowId, workspaceOrder }) =>
    panelLayout
      .insert({ windowId, workspaceOrder })
      .onConflict('windowId', 'update', { workspaceOrder }),
  // -- Hierarchical layout event materializers --------------------------------
  'v1.WindowTabCreated': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.WindowTabClosed': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.WindowTabSwitched': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.WindowTabsReordered': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.PanelTabCreated': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.PanelTabClosed': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.PanelTabSwitched': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.PanelTabsReordered': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.WindowLayoutRestored': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.WindowLayoutSplit': ({ windowId, windowLayout, activeWindowTabId }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.WindowLayoutPaneClosed': ({
    windowId,
    windowLayout,
    activeWindowTabId,
  }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
  'v1.WindowLayoutPaneAssigned': ({
    windowId,
    windowLayout,
    activeWindowTabId,
  }) =>
    panelLayout
      .insert({ windowId, windowLayout, activeWindowTabId })
      .onConflict('windowId', 'update', { windowLayout, activeWindowTabId }),
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
  appSettings,
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
  appSettings,
  panelLayout,
}

// ---------------------------------------------------------------------------
// State & Schema
// ---------------------------------------------------------------------------

const state = State.SQLite.makeState({ tables: activeTables, materializers })

export const schema = makeSchema({ events, state })
