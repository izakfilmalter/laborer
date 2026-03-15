/**
 * Schema round-trip tests for the hierarchical layout types.
 *
 * Verifies that all new types (PanelLeafNode, PanelSplitNode, PanelTab,
 * WorkspaceTileLeaf, WorkspaceTileSplit, WindowTab, WindowLayout) encode
 * and decode correctly through their Effect Schema definitions, including
 * deeply nested recursive trees.
 *
 * @see packages/shared/src/types.ts — Hierarchical Layout Tree section
 * @see Issue #1: Hierarchical layout types
 */

import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import type {
  LeafNode,
  PanelLeafNode,
  PanelSplitNode,
  PanelTab,
  PanelTreeNode,
  WindowLayout,
  WindowTab,
  WorkspaceTileLeaf,
  WorkspaceTileSplit,
} from '../src/types.js'
import {
  LeafNodeSchema,
  PanelLeafNodeSchema,
  PanelSplitNodeSchema,
  PanelTabSchema,
  PanelTreeNodeSchema,
  WindowLayoutSchema,
  WindowTabSchema,
  WorkspaceTileLeafSchema,
  WorkspaceTileNodeSchema,
  WorkspaceTileSplitSchema,
} from '../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode then decode a value through a schema, returning the round-tripped result. */
function roundTrip<T>(schema: Schema.Schema<T>, value: T): T {
  const encoded = Schema.encodeSync(schema)(value)
  return Schema.decodeSync(schema)(encoded)
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const terminalLeaf: PanelLeafNode = {
  _tag: 'PanelLeafNode',
  id: 'pane-1',
  paneType: 'terminal',
  terminalId: 'term-1',
  workspaceId: 'ws-1',
}

const diffLeaf: PanelLeafNode = {
  _tag: 'PanelLeafNode',
  id: 'pane-2',
  paneType: 'diff',
  workspaceId: 'ws-1',
}

const reviewLeaf: PanelLeafNode = {
  _tag: 'PanelLeafNode',
  id: 'pane-3',
  paneType: 'review',
}

const devServerLeaf: PanelLeafNode = {
  _tag: 'PanelLeafNode',
  id: 'pane-4',
  paneType: 'devServerTerminal',
  terminalId: 'dev-term-1',
  workspaceId: 'ws-1',
}

const panelSplit: PanelSplitNode = {
  _tag: 'PanelSplitNode',
  id: 'panel-split-1',
  direction: 'horizontal',
  children: [terminalLeaf, diffLeaf],
  sizes: [60, 40],
}

const nestedPanelSplit: PanelSplitNode = {
  _tag: 'PanelSplitNode',
  id: 'panel-split-outer',
  direction: 'horizontal',
  children: [
    terminalLeaf,
    {
      _tag: 'PanelSplitNode',
      id: 'panel-split-inner',
      direction: 'vertical',
      children: [diffLeaf, reviewLeaf],
      sizes: [50, 50],
    },
  ],
  sizes: [60, 40],
}

const singlePanelTab: PanelTab = {
  id: 'tab-1',
  label: 'Terminal',
  panelLayout: terminalLeaf,
  focusedPaneId: 'pane-1',
}

const splitPanelTab: PanelTab = {
  id: 'tab-2',
  panelLayout: panelSplit,
  focusedPaneId: 'pane-1',
}

const workspaceTileLeaf: WorkspaceTileLeaf = {
  _tag: 'WorkspaceTileLeaf',
  id: 'tile-1',
  workspaceId: 'ws-1',
  panelTabs: [singlePanelTab, splitPanelTab],
  activePanelTabId: 'tab-1',
}

const workspaceTileLeaf2: WorkspaceTileLeaf = {
  _tag: 'WorkspaceTileLeaf',
  id: 'tile-2',
  workspaceId: 'ws-2',
  panelTabs: [
    {
      id: 'tab-3',
      panelLayout: devServerLeaf,
      focusedPaneId: 'pane-4',
    },
  ],
  activePanelTabId: 'tab-3',
}

const workspaceTileSplit: WorkspaceTileSplit = {
  _tag: 'WorkspaceTileSplit',
  id: 'ws-split-1',
  direction: 'horizontal',
  children: [workspaceTileLeaf, workspaceTileLeaf2],
  sizes: [50, 50],
}

// ---------------------------------------------------------------------------
// PanelLeafNode
// ---------------------------------------------------------------------------

describe('PanelLeafNodeSchema', () => {
  it('round-trips a terminal leaf with all fields', () => {
    const result = roundTrip(PanelLeafNodeSchema, terminalLeaf)
    expect(result).toStrictEqual(terminalLeaf)
  })

  it('round-trips a leaf with minimal fields (no optional properties)', () => {
    const minimal: PanelLeafNode = {
      _tag: 'PanelLeafNode',
      id: 'pane-min',
      paneType: 'review',
    }
    const result = roundTrip(PanelLeafNodeSchema, minimal)
    expect(result).toStrictEqual(minimal)
  })

  it('round-trips all pane types', () => {
    for (const paneType of [
      'terminal',
      'diff',
      'devServerTerminal',
      'review',
    ] as const) {
      const leaf: PanelLeafNode = {
        _tag: 'PanelLeafNode',
        id: `pane-${paneType}`,
        paneType,
      }
      const result = roundTrip(PanelLeafNodeSchema, leaf)
      expect(result).toStrictEqual(leaf)
    }
  })
})

// ---------------------------------------------------------------------------
// PanelSplitNode
// ---------------------------------------------------------------------------

describe('PanelSplitNodeSchema', () => {
  it('round-trips a flat split with two children', () => {
    const result = roundTrip(PanelSplitNodeSchema, panelSplit)
    expect(result).toStrictEqual(panelSplit)
  })

  it('round-trips a nested split (3 levels deep)', () => {
    const result = roundTrip(PanelSplitNodeSchema, nestedPanelSplit)
    expect(result).toStrictEqual(nestedPanelSplit)
  })

  it('round-trips a vertical split', () => {
    const vertical: PanelSplitNode = {
      _tag: 'PanelSplitNode',
      id: 'v-split',
      direction: 'vertical',
      children: [terminalLeaf, reviewLeaf],
      sizes: [70, 30],
    }
    const result = roundTrip(PanelSplitNodeSchema, vertical)
    expect(result).toStrictEqual(vertical)
  })
})

// ---------------------------------------------------------------------------
// PanelTreeNode (union)
// ---------------------------------------------------------------------------

describe('PanelTreeNodeSchema', () => {
  it('round-trips a leaf through the union', () => {
    const result = roundTrip(PanelTreeNodeSchema, terminalLeaf)
    expect(result).toStrictEqual(terminalLeaf)
  })

  it('round-trips a split through the union', () => {
    const result = roundTrip(PanelTreeNodeSchema, panelSplit)
    expect(result).toStrictEqual(panelSplit)
  })

  it('round-trips a deeply nested tree (5 levels)', () => {
    const deep: PanelTreeNode = {
      _tag: 'PanelSplitNode',
      id: 'l1',
      direction: 'horizontal',
      children: [
        {
          _tag: 'PanelSplitNode',
          id: 'l2',
          direction: 'vertical',
          children: [
            {
              _tag: 'PanelSplitNode',
              id: 'l3',
              direction: 'horizontal',
              children: [
                {
                  _tag: 'PanelSplitNode',
                  id: 'l4',
                  direction: 'vertical',
                  children: [
                    {
                      _tag: 'PanelLeafNode',
                      id: 'l5-a',
                      paneType: 'terminal',
                    },
                    {
                      _tag: 'PanelLeafNode',
                      id: 'l5-b',
                      paneType: 'diff',
                    },
                  ],
                  sizes: [50, 50],
                },
                {
                  _tag: 'PanelLeafNode',
                  id: 'l3-b',
                  paneType: 'review',
                },
              ],
              sizes: [60, 40],
            },
            {
              _tag: 'PanelLeafNode',
              id: 'l2-b',
              paneType: 'devServerTerminal',
            },
          ],
          sizes: [70, 30],
        },
        {
          _tag: 'PanelLeafNode',
          id: 'l1-b',
          paneType: 'terminal',
        },
      ],
      sizes: [80, 20],
    }
    const result = roundTrip(PanelTreeNodeSchema, deep)
    expect(result).toStrictEqual(deep)
  })
})

// ---------------------------------------------------------------------------
// PanelTab
// ---------------------------------------------------------------------------

describe('PanelTabSchema', () => {
  it('round-trips a tab with a single leaf layout', () => {
    const result = roundTrip(PanelTabSchema, singlePanelTab)
    expect(result).toStrictEqual(singlePanelTab)
  })

  it('round-trips a tab with a split layout', () => {
    const result = roundTrip(PanelTabSchema, splitPanelTab)
    expect(result).toStrictEqual(splitPanelTab)
  })

  it('round-trips a tab with minimal fields (no label, no focusedPaneId)', () => {
    const minimal: PanelTab = {
      id: 'tab-min',
      panelLayout: terminalLeaf,
    }
    const result = roundTrip(PanelTabSchema, minimal)
    expect(result).toStrictEqual(minimal)
  })
})

// ---------------------------------------------------------------------------
// WorkspaceTileLeaf
// ---------------------------------------------------------------------------

describe('WorkspaceTileLeafSchema', () => {
  it('round-trips a workspace tile with multiple panel tabs', () => {
    const result = roundTrip(WorkspaceTileLeafSchema, workspaceTileLeaf)
    expect(result).toStrictEqual(workspaceTileLeaf)
  })

  it('round-trips a workspace tile with a single tab and no activePanelTabId', () => {
    const minimal: WorkspaceTileLeaf = {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-min',
      workspaceId: 'ws-min',
      panelTabs: [singlePanelTab],
    }
    const result = roundTrip(WorkspaceTileLeafSchema, minimal)
    expect(result).toStrictEqual(minimal)
  })

  it('round-trips a workspace tile with empty panel tabs', () => {
    const empty: WorkspaceTileLeaf = {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-empty',
      workspaceId: 'ws-empty',
      panelTabs: [],
    }
    const result = roundTrip(WorkspaceTileLeafSchema, empty)
    expect(result).toStrictEqual(empty)
  })
})

// ---------------------------------------------------------------------------
// WorkspaceTileSplit
// ---------------------------------------------------------------------------

describe('WorkspaceTileSplitSchema', () => {
  it('round-trips a horizontal split with two workspace tiles', () => {
    const result = roundTrip(WorkspaceTileSplitSchema, workspaceTileSplit)
    expect(result).toStrictEqual(workspaceTileSplit)
  })

  it('round-trips a nested workspace tile split', () => {
    const thirdTile: WorkspaceTileLeaf = {
      _tag: 'WorkspaceTileLeaf',
      id: 'tile-3',
      workspaceId: 'ws-3',
      panelTabs: [
        {
          id: 'tab-4',
          panelLayout: reviewLeaf,
        },
      ],
    }

    const nested: WorkspaceTileSplit = {
      _tag: 'WorkspaceTileSplit',
      id: 'ws-split-outer',
      direction: 'vertical',
      children: [workspaceTileSplit, thirdTile],
      sizes: [70, 30],
    }
    const result = roundTrip(WorkspaceTileSplitSchema, nested)
    expect(result).toStrictEqual(nested)
  })
})

// ---------------------------------------------------------------------------
// WorkspaceTileNode (union)
// ---------------------------------------------------------------------------

describe('WorkspaceTileNodeSchema', () => {
  it('round-trips a leaf through the union', () => {
    const result = roundTrip(WorkspaceTileNodeSchema, workspaceTileLeaf)
    expect(result).toStrictEqual(workspaceTileLeaf)
  })

  it('round-trips a split through the union', () => {
    const result = roundTrip(WorkspaceTileNodeSchema, workspaceTileSplit)
    expect(result).toStrictEqual(workspaceTileSplit)
  })
})

// ---------------------------------------------------------------------------
// WindowTab
// ---------------------------------------------------------------------------

describe('WindowTabSchema', () => {
  it('round-trips a window tab with a workspace layout', () => {
    const tab: WindowTab = {
      id: 'win-tab-1',
      label: 'Feature Work',
      workspaceLayout: workspaceTileSplit,
    }
    const result = roundTrip(WindowTabSchema, tab)
    expect(result).toStrictEqual(tab)
  })

  it('round-trips an empty window tab (no workspace layout)', () => {
    const emptyTab: WindowTab = {
      id: 'win-tab-empty',
    }
    const result = roundTrip(WindowTabSchema, emptyTab)
    expect(result).toStrictEqual(emptyTab)
  })

  it('round-trips a window tab with minimal fields', () => {
    const minimalTab: WindowTab = {
      id: 'win-tab-min',
      workspaceLayout: workspaceTileLeaf,
    }
    const result = roundTrip(WindowTabSchema, minimalTab)
    expect(result).toStrictEqual(minimalTab)
  })
})

// ---------------------------------------------------------------------------
// WindowLayout (top-level)
// ---------------------------------------------------------------------------

describe('WindowLayoutSchema', () => {
  it('round-trips a layout with multiple tabs', () => {
    const layout: WindowLayout = {
      tabs: [
        {
          id: 'win-tab-1',
          label: 'Feature Work',
          workspaceLayout: workspaceTileSplit,
        },
        {
          id: 'win-tab-2',
          label: 'Code Review',
          workspaceLayout: workspaceTileLeaf2,
        },
      ],
      activeTabId: 'win-tab-1',
    }
    const result = roundTrip(WindowLayoutSchema, layout)
    expect(result).toStrictEqual(layout)
  })

  it('round-trips a layout with a single tab', () => {
    const layout: WindowLayout = {
      tabs: [
        {
          id: 'win-tab-only',
          workspaceLayout: workspaceTileLeaf,
        },
      ],
      activeTabId: 'win-tab-only',
    }
    const result = roundTrip(WindowLayoutSchema, layout)
    expect(result).toStrictEqual(layout)
  })

  it('round-trips an empty layout (no tabs)', () => {
    const layout: WindowLayout = {
      tabs: [],
    }
    const result = roundTrip(WindowLayoutSchema, layout)
    expect(result).toStrictEqual(layout)
  })

  it('round-trips a deeply nested complete layout', () => {
    /**
     * Full hierarchy:
     * WindowLayout
     *   └─ WindowTab "Main"
     *       └─ WorkspaceTileSplit (horizontal)
     *           ├─ WorkspaceTileLeaf ws-1
     *           │   ├─ PanelTab "Terminal" (single leaf)
     *           │   └─ PanelTab "Split" (horizontal split: terminal + diff)
     *           └─ WorkspaceTileSplit (vertical)
     *               ├─ WorkspaceTileLeaf ws-2 (devServer tab)
     *               └─ WorkspaceTileLeaf ws-3 (review tab)
     */
    const layout: WindowLayout = {
      tabs: [
        {
          id: 'win-tab-main',
          label: 'Main',
          workspaceLayout: {
            _tag: 'WorkspaceTileSplit',
            id: 'root-split',
            direction: 'horizontal',
            children: [
              workspaceTileLeaf,
              {
                _tag: 'WorkspaceTileSplit',
                id: 'inner-split',
                direction: 'vertical',
                children: [
                  workspaceTileLeaf2,
                  {
                    _tag: 'WorkspaceTileLeaf',
                    id: 'tile-3',
                    workspaceId: 'ws-3',
                    panelTabs: [
                      {
                        id: 'tab-review',
                        panelLayout: reviewLeaf,
                        focusedPaneId: 'pane-3',
                      },
                    ],
                    activePanelTabId: 'tab-review',
                  },
                ],
                sizes: [50, 50],
              },
            ],
            sizes: [60, 40],
          },
        },
      ],
      activeTabId: 'win-tab-main',
    }
    const result = roundTrip(WindowLayoutSchema, layout)
    expect(result).toStrictEqual(layout)
  })
})

// ---------------------------------------------------------------------------
// Legacy types preserved (old LeafNode, SplitNode, PanelNode)
// ---------------------------------------------------------------------------

describe('Legacy PanelNode types are preserved', () => {
  it('old LeafNodeSchema still encodes/decodes with sidebar toggle flags', () => {
    const oldLeaf: LeafNode = {
      _tag: 'LeafNode',
      id: 'old-pane-1',
      paneType: 'terminal',
      diffOpen: true,
      devServerOpen: false,
      devServerTerminalId: 'dev-1',
      terminalId: 'term-1',
      workspaceId: 'ws-1',
    }
    const encoded = Schema.encodeSync(LeafNodeSchema)(oldLeaf)
    const decoded = Schema.decodeSync(LeafNodeSchema)(encoded)
    expect(decoded).toStrictEqual(oldLeaf)
  })
})
