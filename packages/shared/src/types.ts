import { Schema } from 'effect'

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export const ProjectId = Schema.String.pipe(Schema.brand('ProjectId'))
export type ProjectId = typeof ProjectId.Type

export const WorkspaceId = Schema.String.pipe(Schema.brand('WorkspaceId'))
export type WorkspaceId = typeof WorkspaceId.Type

export const TerminalId = Schema.String.pipe(Schema.brand('TerminalId'))
export type TerminalId = typeof TerminalId.Type

export const TaskId = Schema.String.pipe(Schema.brand('TaskId'))
export type TaskId = typeof TaskId.Type

export const PrdId = Schema.String.pipe(Schema.brand('PrdId'))
export type PrdId = typeof PrdId.Type

// ---------------------------------------------------------------------------
// Enums (Variants)
// ---------------------------------------------------------------------------

export const WorkspaceStatus = Schema.Literal(
  'creating',
  'running',
  'stopped',
  'errored',
  'destroyed'
)
export type WorkspaceStatus = typeof WorkspaceStatus.Type

export const WorkspaceOrigin = Schema.Literal('laborer', 'external')
export type WorkspaceOrigin = typeof WorkspaceOrigin.Type

export const TerminalStatus = Schema.Literal('running', 'stopped')
export type TerminalStatus = typeof TerminalStatus.Type

export const TaskSource = Schema.Literal('linear', 'github', 'manual', 'prd')
export type TaskSource = typeof TaskSource.Type

export const TaskStatus = Schema.Literal(
  'pending',
  'in_progress',
  'completed',
  'cancelled'
)
export type TaskStatus = typeof TaskStatus.Type

export const ContainerStatus = Schema.Literal('running', 'paused')
export type ContainerStatus = typeof ContainerStatus.Type

export const PrdStatus = Schema.Literal('draft', 'active', 'completed')
export type PrdStatus = typeof PrdStatus.Type

export const PaneType = Schema.Literal(
  'agent',
  'terminal',
  'diff',
  'devServerTerminal',
  'review'
)
export type PaneType = typeof PaneType.Type

export const SplitDirection = Schema.Literal('horizontal', 'vertical')
export type SplitDirection = typeof SplitDirection.Type

// ---------------------------------------------------------------------------
// Domain Models
// ---------------------------------------------------------------------------

export class Project extends Schema.Class<Project>('Project')({
  id: ProjectId,
  repoPath: Schema.String,
  repoId: Schema.optional(Schema.String),
  canonicalGitCommonDir: Schema.optional(Schema.String),
  name: Schema.String,
  brrrConfig: Schema.optional(Schema.String),
}) {}

export class Workspace extends Schema.Class<Workspace>('Workspace')({
  id: WorkspaceId,
  projectId: ProjectId,
  taskSource: Schema.optional(Schema.String),
  branchName: Schema.String,
  worktreePath: Schema.String,
  status: WorkspaceStatus,
  origin: WorkspaceOrigin,
  createdAt: Schema.Date,
}) {}

export class Terminal extends Schema.Class<Terminal>('Terminal')({
  id: TerminalId,
  workspaceId: WorkspaceId,
  command: Schema.String,
  status: TerminalStatus,
  ptySessionRef: Schema.optional(Schema.String),
}) {}

export class Task extends Schema.Class<Task>('Task')({
  id: TaskId,
  projectId: ProjectId,
  source: TaskSource,
  prdId: Schema.optional(Schema.String),
  externalId: Schema.optional(Schema.String),
  title: Schema.String,
  status: TaskStatus,
}) {}

export class Prd extends Schema.Class<Prd>('Prd')({
  id: PrdId,
  projectId: ProjectId,
  title: Schema.String,
  slug: Schema.String,
  filePath: Schema.String,
  status: PrdStatus,
  createdAt: Schema.Date,
}) {}

export class Diff extends Schema.Class<Diff>('Diff')({
  workspaceId: WorkspaceId,
  diffContent: Schema.String,
  lastUpdated: Schema.Date,
}) {}

// ---------------------------------------------------------------------------
// Panel Layout Tree (Hierarchical)
// ---------------------------------------------------------------------------

/**
 * A leaf node in the panel split tree. Represents a single pane that can
 * hold a terminal, agent, diff, dev server, or review session.
 */
export interface LeafNode {
  readonly _tag: 'LeafNode'
  readonly id: string
  readonly paneType: PaneType
  readonly terminalId?: string | undefined
  readonly workspaceId?: string | undefined
}

export interface SplitNode {
  readonly _tag: 'SplitNode'
  readonly children: readonly PanelNode[]
  readonly direction: SplitDirection
  readonly id: string
  readonly sizes: readonly number[]
}

export type PanelNode = LeafNode | SplitNode

export const LeafNodeSchema: Schema.Schema<LeafNode> = Schema.TaggedStruct(
  'LeafNode',
  {
    id: Schema.String,
    paneType: PaneType,
    terminalId: Schema.optional(Schema.String),
    workspaceId: Schema.optional(Schema.String),
  }
)

export const SplitNodeSchema: Schema.Schema<SplitNode> = Schema.TaggedStruct(
  'SplitNode',
  {
    id: Schema.String,
    direction: SplitDirection,
    children: Schema.Array(
      Schema.suspend((): Schema.Schema<PanelNode> => PanelNodeSchema)
    ),
    sizes: Schema.Array(Schema.Number),
  }
)

export const PanelNodeSchema: Schema.Schema<PanelNode> = Schema.Union(
  LeafNodeSchema,
  SplitNodeSchema
)

// ---------------------------------------------------------------------------
// Hierarchical Layout Tree (Window Tabs > Workspace Tiles > Panel Tabs)
// ---------------------------------------------------------------------------

// -- Panel Tab --------------------------------------------------------------

/**
 * A tab within a workspace's tab bar. Each panel tab contains a split tree
 * of panel panes and tracks which pane is focused within it.
 */
export interface PanelTab {
  readonly focusedPaneId?: string | undefined
  readonly id: string
  readonly label?: string | undefined
  readonly panelLayout: PanelNode
}

export const PanelTabSchema: Schema.Schema<PanelTab> = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  panelLayout: PanelNodeSchema,
  focusedPaneId: Schema.optional(Schema.String),
})

// -- Workspace Tile Tree ----------------------------------------------------

/**
 * A leaf in the workspace tile tree — represents a single workspace frame
 * containing an ordered list of panel tabs.
 */
export interface WorkspaceTileLeaf {
  readonly _tag: 'WorkspaceTileLeaf'
  readonly activePanelTabId?: string | undefined
  readonly id: string
  readonly panelTabs: readonly PanelTab[]
  readonly workspaceId: string
}

/**
 * A split node in the workspace tile tree — tiles workspaces horizontally
 * or vertically within a window tab.
 */
export interface WorkspaceTileSplit {
  readonly _tag: 'WorkspaceTileSplit'
  readonly children: readonly WorkspaceTileNode[]
  readonly direction: SplitDirection
  readonly id: string
  readonly sizes: readonly number[]
}

export type WorkspaceTileNode = WorkspaceTileLeaf | WorkspaceTileSplit

export const WorkspaceTileLeafSchema: Schema.Schema<WorkspaceTileLeaf> =
  Schema.TaggedStruct('WorkspaceTileLeaf', {
    id: Schema.String,
    workspaceId: Schema.String,
    panelTabs: Schema.Array(PanelTabSchema),
    activePanelTabId: Schema.optional(Schema.String),
  })

export const WorkspaceTileSplitSchema: Schema.Schema<WorkspaceTileSplit> =
  Schema.TaggedStruct('WorkspaceTileSplit', {
    id: Schema.String,
    direction: SplitDirection,
    children: Schema.Array(
      Schema.suspend(
        (): Schema.Schema<WorkspaceTileNode> => WorkspaceTileNodeSchema
      )
    ),
    sizes: Schema.Array(Schema.Number),
  })

export const WorkspaceTileNodeSchema: Schema.Schema<WorkspaceTileNode> =
  Schema.Union(WorkspaceTileLeafSchema, WorkspaceTileSplitSchema)

// -- Window Tab -------------------------------------------------------------

/**
 * A top-level tab in the work area's tab bar. Each window tab contains an
 * independent arrangement of workspaces as a tile tree.
 */
export interface WindowTab {
  readonly id: string
  readonly label?: string | undefined
  readonly workspaceLayout?: WorkspaceTileNode | undefined
}

export const WindowTabSchema: Schema.Schema<WindowTab> = Schema.Struct({
  id: Schema.String,
  label: Schema.optional(Schema.String),
  workspaceLayout: Schema.optional(WorkspaceTileNodeSchema),
})

// -- Window Layout (top-level) ----------------------------------------------

/**
 * The complete hierarchical layout for a single Electron window.
 * Contains an ordered list of window tabs, with one marked as active.
 */
export interface WindowLayout {
  readonly activeTabId?: string | undefined
  readonly tabs: readonly WindowTab[]
}

export const WindowLayoutSchema: Schema.Schema<WindowLayout> = Schema.Struct({
  tabs: Schema.Array(WindowTabSchema),
  activeTabId: Schema.optional(Schema.String),
})
