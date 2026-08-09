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

export const ContainerStatus = Schema.Literal('running', 'paused')
export type ContainerStatus = typeof ContainerStatus.Type

const ActivePaneType = Schema.Literal(
  'agent',
  'terminal',
  'diff',
  'devServerTerminal'
)

/** Decode removed review panes in saved layouts as diff panes. */
export const PaneType = Schema.Union(
  ActivePaneType,
  Schema.transformLiteral('review', 'diff')
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
 * hold a terminal, agent, diff, or dev server session.
 */
export interface LeafNode {
  readonly _tag: 'LeafNode'
  /**
   * Spawn intent: the command this pane's terminal was created with
   * (e.g. `opencode`, `claude`). Undefined for plain shells. Persisted
   * so a genuinely-dead terminal respawns as what it was — an agent
   * pane must never silently degrade to a plain shell (ADR 0003).
   */
  readonly command?: string | undefined
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

export interface EncodedLeafNode extends Omit<LeafNode, 'paneType'> {
  readonly paneType: PaneType | 'review'
}

export interface EncodedSplitNode extends Omit<SplitNode, 'children'> {
  readonly children: readonly EncodedPanelNode[]
}

export type EncodedPanelNode = EncodedLeafNode | EncodedSplitNode

export const LeafNodeSchema: Schema.Schema<LeafNode, EncodedLeafNode> =
  Schema.TaggedStruct('LeafNode', {
    command: Schema.optional(Schema.String),
    id: Schema.String,
    paneType: PaneType,
    terminalId: Schema.optional(Schema.String),
    workspaceId: Schema.optional(Schema.String),
  })

export const SplitNodeSchema: Schema.Schema<SplitNode, EncodedSplitNode> =
  Schema.TaggedStruct('SplitNode', {
    id: Schema.String,
    direction: SplitDirection,
    children: Schema.Array(
      Schema.suspend(
        (): Schema.Schema<PanelNode, EncodedPanelNode> => PanelNodeSchema
      )
    ),
    sizes: Schema.Array(Schema.Number),
  })

export const PanelNodeSchema: Schema.Schema<PanelNode, EncodedPanelNode> =
  Schema.Union(LeafNodeSchema, SplitNodeSchema)

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

export interface EncodedPanelTab extends Omit<PanelTab, 'panelLayout'> {
  readonly panelLayout: EncodedPanelNode
}

export const PanelTabSchema: Schema.Schema<PanelTab, EncodedPanelTab> =
  Schema.Struct({
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

export interface EncodedWorkspaceTileLeaf
  extends Omit<WorkspaceTileLeaf, 'panelTabs'> {
  readonly panelTabs: readonly EncodedPanelTab[]
}

export interface EncodedWorkspaceTileSplit
  extends Omit<WorkspaceTileSplit, 'children'> {
  readonly children: readonly EncodedWorkspaceTileNode[]
}

export type EncodedWorkspaceTileNode =
  | EncodedWorkspaceTileLeaf
  | EncodedWorkspaceTileSplit

export const WorkspaceTileLeafSchema: Schema.Schema<
  WorkspaceTileLeaf,
  EncodedWorkspaceTileLeaf
> = Schema.TaggedStruct('WorkspaceTileLeaf', {
  id: Schema.String,
  workspaceId: Schema.String,
  panelTabs: Schema.Array(PanelTabSchema),
  activePanelTabId: Schema.optional(Schema.String),
})

export const WorkspaceTileSplitSchema: Schema.Schema<
  WorkspaceTileSplit,
  EncodedWorkspaceTileSplit
> = Schema.TaggedStruct('WorkspaceTileSplit', {
  id: Schema.String,
  direction: SplitDirection,
  children: Schema.Array(
    Schema.suspend(
      (): Schema.Schema<WorkspaceTileNode, EncodedWorkspaceTileNode> =>
        WorkspaceTileNodeSchema
    )
  ),
  sizes: Schema.Array(Schema.Number),
})

export const WorkspaceTileNodeSchema: Schema.Schema<
  WorkspaceTileNode,
  EncodedWorkspaceTileNode
> = Schema.Union(WorkspaceTileLeafSchema, WorkspaceTileSplitSchema)

// -- Window Tab -------------------------------------------------------------

/**
 * A top-level tab in the work area's tab bar. Each window tab contains an
 * independent arrangement of workspaces as a tile tree.
 */
export interface WindowTab {
  readonly focusedWorkspaceTileId?: string | undefined
  readonly id: string
  readonly label?: string | undefined
  readonly workspaceLayout?: WorkspaceTileNode | undefined
}

export interface EncodedWindowTab extends Omit<WindowTab, 'workspaceLayout'> {
  readonly workspaceLayout?: EncodedWorkspaceTileNode | undefined
}

export const WindowTabSchema: Schema.Schema<WindowTab, EncodedWindowTab> =
  Schema.Struct({
    focusedWorkspaceTileId: Schema.optional(Schema.String),
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

export interface EncodedWindowLayout extends Omit<WindowLayout, 'tabs'> {
  readonly tabs: readonly EncodedWindowTab[]
}

export const WindowLayoutSchema: Schema.Schema<
  WindowLayout,
  EncodedWindowLayout
> = Schema.Struct({
  tabs: Schema.Array(WindowTabSchema),
  activeTabId: Schema.optional(Schema.String),
})
