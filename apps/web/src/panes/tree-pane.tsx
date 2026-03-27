/**
 * File tree pane component — renders a file tree using @pierre/trees.
 *
 * Displayed as a left-side panel alongside workspace frames, mirroring
 * how the diff pane is rendered on the right side.
 *
 * For now, renders an empty tree placeholder. A server-side service
 * will provide the file list via LiveStore (similar to DiffService).
 */

interface TreePaneProps {
  /** Callback to close the tree pane. */
  readonly onClose?: (() => void) | undefined
  /** The workspace whose file tree to display. */
  readonly workspaceId: string
}

function TreePane({ workspaceId, onClose }: TreePaneProps) {
  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="tree-pane"
      data-workspace-id={workspaceId}
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
        <span className="font-medium text-xs">Files</span>
        {onClose && (
          <button
            aria-label="Close file tree"
            className="text-muted-foreground hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            &times;
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {/* File tree will be populated once the server provides file data */}
      </div>
    </div>
  )
}

export { TreePane }
export type { TreePaneProps }
