import { Events, makeSchema, Schema, State } from '@livestore/livestore'
import { PersistedWindowLayoutSchema } from './types.js'

const HistoricalPrdStatus = Schema.Literal('draft', 'active', 'completed')

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
  },
})

export const workspaces = State.SQLite.table({
  name: 'workspaces',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    projectId: State.SQLite.text(),
    /** @deprecated — Legacy task link retained while historical workspace events remain materialized. */
    taskSource: State.SQLite.text({ nullable: true }),
    branchName: State.SQLite.text(),
    worktreePath: State.SQLite.text(),
    status: State.SQLite.text({ default: 'creating' }),
    origin: State.SQLite.text({ default: 'laborer' }),
    createdAt: State.SQLite.text(),
    /** SHA of the parent branch HEAD when the worktree was created. Used by DiffService as the base for `git diff`. */
    baseSha: State.SQLite.text({ nullable: true }),
    /**
     * Branch this workspace's PR targets, captured from the parent workspace at
     * creation time. Null for ordinary workspaces (PRs target the repo default
     * branch). Sidebar lineage is derived by matching this against live
     * workspaces' branchName — see docs/adr/0001-branch-keyed-workspace-lineage.md.
     */
    baseBranch: State.SQLite.text({ nullable: true }),
    /** Sandbox ID when a dev server sandbox is running for this workspace. Null when no sandbox exists. */
    sandboxId: State.SQLite.text({ nullable: true }),
    /** The URL for the sandbox dev server. Null when no sandbox exists. */
    sandboxUrl: State.SQLite.text({ nullable: true }),
    /** Port the dev server listens on inside the sandbox. Null when not configured. */
    sandboxPort: State.SQLite.integer({ nullable: true }),
    /** The image used for the sandbox (e.g., `node:22`). Null when no sandbox exists. */
    sandboxImage: State.SQLite.text({ nullable: true }),
    /** The current sandbox status: 'running' or 'paused'. Null when no sandbox exists. */
    sandboxStatus: State.SQLite.text({ nullable: true }),
    /** Current step of the background sandbox setup process. Null when setup is complete or not started. */
    sandboxSetupStep: State.SQLite.text({ nullable: true }),
    /** Which sandbox provider was used: 'docker', 'daytona', or 'none'. Null for workspaces created before provider support. */
    sandboxProvider: State.SQLite.text({ nullable: true }),
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
    /** Human-readable error message when the workspace is in 'errored' status. Null when not errored. */
    errorMessage: State.SQLite.text({ nullable: true }),
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

/**
 * @deprecated — diffs table removed as part of Lazy File Service migration.
 * Retained for backward compatibility in tests that reference `tables.diffs`.
 * Not registered in `activeTables`.
 */
export const diffs = State.SQLite.table({
  name: 'diffs',
  columns: {
    workspaceId: State.SQLite.text({ primaryKey: true }),
    diffContent: State.SQLite.text({ default: '' }),
    lastUpdated: State.SQLite.text(),
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
 * PanelLayout is per-renderer UI state, so keep it in a LiveStore client
 * document instead of a custom synced/client-only event stream. This follows
 * LiveStore's reference pattern for local UI state and avoids rebasing layout
 * changes with backend workspace events.
 */
export const panelLayout = State.SQLite.clientDocument({
  name: 'panel_layout',
  schema: Schema.Struct({
    windowLayout: Schema.NullOr(PersistedWindowLayoutSchema),
  }),
  default: {
    value: { windowLayout: null },
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
    /** @deprecated — Port allocation removed. Field retained for backward compatibility with old events. */
    port: Schema.optional(Schema.Number),
    status: Schema.String,
    origin: Schema.optionalWith(Schema.String, {
      default: () => 'laborer',
    }),
    createdAt: Schema.String,
    /** SHA of the parent branch HEAD when the worktree was created. Null for workspaces created before this field existed. */
    baseSha: Schema.optionalWith(Schema.NullOr(Schema.String), {
      default: () => null,
    }),
    /** Provider selected when creating the workspace. Optional for backward compatibility with old events. */
    sandboxProvider: Schema.optional(Schema.NullOr(Schema.String)),
    /** Branch this workspace's PR targets (sub-workspaces only). Optional for backward compatibility with old events. */
    baseBranch: Schema.optional(Schema.NullOr(Schema.String)),
  }),
})

export const workspaceStatusChanged = Events.synced({
  name: 'v1.WorkspaceStatusChanged',
  schema: Schema.Struct({
    id: Schema.String,
    status: Schema.String,
    /** Human-readable error message when transitioning to 'errored'. Optional for backward compat with old events. */
    errorMessage: Schema.optional(Schema.NullOr(Schema.String)),
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

export const workspaceOriginChanged = Events.synced({
  name: 'v1.WorkspaceOriginChanged',
  schema: Schema.Struct({
    id: Schema.String,
    origin: Schema.String,
  }),
})

export const containerStarted = Events.synced({
  name: 'v1.ContainerStarted',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    containerId: Schema.String,
    containerUrl: Schema.String,
    containerImage: Schema.String,
    /** Port the dev server listens on. Optional for backward compat with old events. */
    containerPort: Schema.optional(Schema.Number),
  }),
})

export const containerPortChanged = Events.synced({
  name: 'v1.ContainerPortChanged',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    /** The new port, or null to clear. */
    containerPort: Schema.NullOr(Schema.Number),
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
    status: Schema.optionalWith(HistoricalPrdStatus, {
      default: () => 'draft',
    }),
    createdAt: Schema.String,
  }),
})

export const prdStatusChanged = Events.synced({
  name: 'v1.PrdStatusChanged',
  schema: Schema.Struct({
    id: Schema.String,
    status: HistoricalPrdStatus,
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
    status: HistoricalPrdStatus,
    createdAt: Schema.String,
  }),
})

export const prdRemoved = Events.synced({
  name: 'v1.PrdRemoved',
  schema: Schema.Struct({
    id: Schema.String,
  }),
})

// -- v2 Sandbox events (provider-agnostic) -----------------------------------

export const sandboxStarted = Events.synced({
  name: 'v2.SandboxStarted',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    sandboxId: Schema.String,
    sandboxUrl: Schema.String,
    sandboxImage: Schema.String,
    /** Port the dev server listens on. Optional for backward compat. */
    sandboxPort: Schema.optional(Schema.Number),
    /** Which provider created this sandbox: 'docker' or 'daytona'. */
    sandboxProvider: Schema.String,
  }),
})

export const sandboxStopped = Events.synced({
  name: 'v2.SandboxStopped',
  schema: Schema.Struct({
    workspaceId: Schema.String,
  }),
})

export const sandboxPaused = Events.synced({
  name: 'v2.SandboxPaused',
  schema: Schema.Struct({
    workspaceId: Schema.String,
  }),
})

export const sandboxResumed = Events.synced({
  name: 'v2.SandboxResumed',
  schema: Schema.Struct({
    workspaceId: Schema.String,
  }),
})

export const sandboxSetupStepChanged = Events.synced({
  name: 'v2.SandboxSetupStepChanged',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    /** Current setup step, or null when setup is complete. */
    step: Schema.NullOr(Schema.String),
  }),
})

export const sandboxPortChanged = Events.synced({
  name: 'v2.SandboxPortChanged',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    /** The new port, or null to clear. */
    sandboxPort: Schema.NullOr(Schema.Number),
  }),
})

export const sandboxUrlChanged = Events.synced({
  name: 'v2.SandboxUrlChanged',
  schema: Schema.Struct({
    workspaceId: Schema.String,
    /** The new preview URL (full URL for Daytona, hostname for Docker). */
    sandboxUrl: Schema.String,
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

// -- Panel Layout event ------------------------------------------------------

/**
 * The single client-only event for all layout mutations. Carries the full
 * `WindowLayout` tree; the materializer upserts on `windowId`. Layout is
 * per Electron window, so it must not participate in backend sync/rebase.
 * The optional `reason` field is purely for debugging/auditability.
 */
export const windowLayoutUpdated = Events.clientOnly({
  name: 'v1.WindowLayoutUpdated',
  schema: Schema.Struct({
    windowId: Schema.String,
    windowLayout: PersistedWindowLayoutSchema,
    reason: Schema.optional(Schema.String),
  }),
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
  workspaceOriginChanged,
  containerStarted,
  containerPortChanged,
  containerStopped,
  containerPaused,
  containerUnpaused,
  containerSetupStepChanged,
  sandboxStarted,
  sandboxStopped,
  sandboxPaused,
  sandboxResumed,
  sandboxSetupStepChanged,
  sandboxPortChanged,
  sandboxUrlChanged,
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
  panelLayoutSet: panelLayout.set,
  windowLayoutUpdated,
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
  }) =>
    projects.insert({
      id,
      repoPath,
      repoId: repoId ?? null,
      canonicalGitCommonDir: canonicalGitCommonDir ?? null,
      name,
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
    status,
    origin,
    createdAt,
    baseSha,
    sandboxProvider,
    baseBranch,
  }) =>
    workspaces.insert({
      id,
      projectId,
      taskSource,
      branchName,
      worktreePath,
      status,
      origin,
      createdAt,
      baseSha,
      baseBranch: baseBranch ?? null,
      sandboxId: null,
      sandboxUrl: null,
      sandboxImage: null,
      sandboxStatus: null,
      sandboxSetupStep: null,
      sandboxProvider: sandboxProvider ?? null,
      worktreeSetupStep: null,
      prNumber: null,
      prUrl: null,
      prTitle: null,
      prState: null,
      aheadCount: null,
      behindCount: null,
      errorMessage: null,
    }),
  'v1.WorkspaceStatusChanged': ({ id, status, errorMessage }) => {
    if (status === 'running') {
      return workspaces
        .update({ status, worktreeSetupStep: null, errorMessage: null })
        .where({ id })
    }
    if (status === 'errored') {
      return workspaces
        .update({ status, errorMessage: errorMessage ?? null })
        .where({ id })
    }
    return workspaces.update({ status, errorMessage: null }).where({ id })
  },
  'v1.WorkspaceBranchChanged': ({ id, branchName }) =>
    workspaces.update({ branchName }).where({ id }),
  'v1.WorkspaceBaseShaUpdated': ({ id, baseSha }) =>
    workspaces.update({ baseSha }).where({ id }),
  'v1.WorkspaceDestroyed': ({ id }) => workspaces.delete().where({ id }),
  'v1.WorkspacePrUpdated': ({ id, prNumber, prUrl, prTitle, prState }) =>
    workspaces.update({ prNumber, prUrl, prTitle, prState }).where({ id }),
  'v1.WorkspaceSyncStatusUpdated': ({ id, aheadCount, behindCount }) =>
    workspaces.update({ aheadCount, behindCount }).where({ id }),
  'v1.WorkspaceOriginChanged': ({ id, origin }) =>
    workspaces.update({ origin }).where({ id }),
  'v1.ContainerStarted': ({
    workspaceId,
    containerId,
    containerUrl,
    containerImage,
    containerPort,
  }) =>
    workspaces
      .update({
        sandboxId: containerId,
        sandboxUrl: containerUrl,
        sandboxImage: containerImage,
        sandboxPort: containerPort ?? null,
        sandboxStatus: 'running',
        sandboxSetupStep: null,
      })
      .where({ id: workspaceId }),
  'v1.ContainerPortChanged': ({ workspaceId, containerPort }) =>
    workspaces
      .update({ sandboxPort: containerPort })
      .where({ id: workspaceId }),
  'v1.ContainerStopped': ({ workspaceId }) =>
    workspaces
      .update({
        sandboxId: null,
        sandboxStatus: null,
        sandboxSetupStep: null,
      })
      .where({ id: workspaceId }),
  'v1.ContainerPaused': ({ workspaceId }) =>
    workspaces.update({ sandboxStatus: 'paused' }).where({ id: workspaceId }),
  'v1.ContainerUnpaused': ({ workspaceId }) =>
    workspaces.update({ sandboxStatus: 'running' }).where({ id: workspaceId }),
  'v1.ContainerSetupStepChanged': ({ workspaceId, step }) =>
    workspaces.update({ sandboxSetupStep: step }).where({ id: workspaceId }),
  'v2.SandboxStarted': ({
    workspaceId,
    sandboxId,
    sandboxUrl,
    sandboxImage,
    sandboxPort,
    sandboxProvider,
  }) =>
    workspaces
      .update({
        sandboxId,
        sandboxUrl,
        sandboxImage,
        sandboxPort: sandboxPort ?? null,
        sandboxStatus: 'running',
        sandboxSetupStep: null,
        sandboxProvider,
      })
      .where({ id: workspaceId }),
  'v2.SandboxStopped': ({ workspaceId }) =>
    workspaces
      .update({
        sandboxId: null,
        sandboxStatus: null,
        sandboxSetupStep: null,
      })
      .where({ id: workspaceId }),
  'v2.SandboxPaused': ({ workspaceId }) =>
    workspaces.update({ sandboxStatus: 'paused' }).where({ id: workspaceId }),
  'v2.SandboxResumed': ({ workspaceId }) =>
    workspaces.update({ sandboxStatus: 'running' }).where({ id: workspaceId }),
  'v2.SandboxSetupStepChanged': ({ workspaceId, step }) =>
    workspaces.update({ sandboxSetupStep: step }).where({ id: workspaceId }),
  'v2.SandboxPortChanged': ({ workspaceId, sandboxPort }) =>
    workspaces.update({ sandboxPort }).where({ id: workspaceId }),
  'v2.SandboxUrlChanged': ({ workspaceId, sandboxUrl }) =>
    workspaces.update({ sandboxUrl }).where({ id: workspaceId }),
  'v1.WorktreeSetupStepChanged': ({ workspaceId, step }) =>
    workspaces.update({ worktreeSetupStep: step }).where({ id: workspaceId }),
  'v1.TerminalSpawned': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalOutput': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #143)
  'v1.TerminalStatusChanged': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalKilled': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalRemoved': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.TerminalRestarted': () => [], // @deprecated — no-op materializer retained for backward compat (Issue #145)
  'v1.DiffUpdated': () => [], // @deprecated — no-op materializer retained for backward compat (Lazy File Service)
  'v1.DiffCleared': () => [], // @deprecated — no-op materializer retained for backward compat (Lazy File Service)
  'v1.TaskCreated': () => [],
  'v1.TaskStatusChanged': () => [],
  'v1.TaskRemoved': () => [],
  'v1.PrdCreated': () => [],
  'v1.PrdUpdated': () => [],
  'v1.PrdStatusChanged': () => [],
  'v1.PrdRemoved': () => [],
  'v1.AppSettingChanged': ({ key, value }) =>
    appSettings.insert({ key, value }).onConflict('key', 'replace'),
  // Legacy layout events are intentionally ignored. Current layout state is
  // stored via `panelLayout.set`, the built-in client-document event.
  'v1.WindowLayoutUpdated': () => [],
})

// ---------------------------------------------------------------------------
// Tables export
// ---------------------------------------------------------------------------

export const tables = {
  projects,
  workspaces,
  terminals,
  diffs,
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
  appSettings,
  panelLayout,
}

// ---------------------------------------------------------------------------
// State & Schema
// ---------------------------------------------------------------------------

const state = State.SQLite.makeState({ tables: activeTables, materializers })

export const schema = makeSchema({ events, state })
