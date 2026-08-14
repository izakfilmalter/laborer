import type { FileNode } from '@laborer/shared/rpc'
import { ChevronRight } from 'lucide-react'
import { Fragment, useMemo } from 'react'
import { cn } from '@/lib/utils'
import { FileIcon } from '@/panes/file-tree/file-icon'
import type { FileTreeStore } from '@/panes/file-tree/use-file-tree-store'

type GitStatusKind = 'added' | 'deleted' | 'modified'

interface GitStatusEntry {
  readonly path: string
  readonly status: GitStatusKind
}

export interface TreeViewSelectionItem {
  readonly path: string
  readonly type: 'file' | 'directory'
}

interface FileTreeViewProps {
  readonly gitStatus: readonly GitStatusEntry[]
  readonly onContextMenuItem: (item: TreeViewSelectionItem) => void
  readonly onSelect: (item: TreeViewSelectionItem) => void
  readonly selectedPath: string | null
  readonly store: Pick<
    FileTreeStore,
    'children' | 'collapseDir' | 'expandDir' | 'isDirExpanded'
  >
}

const gitStatusLabel = (status: GitStatusKind) => {
  if (status === 'added') {
    return 'A'
  }
  if (status === 'deleted') {
    return 'D'
  }
  return 'M'
}

const gitStatusTextClass = (status: GitStatusKind) => {
  if (status === 'added') {
    return 'text-emerald-500'
  }
  if (status === 'deleted') {
    return 'text-red-500'
  }
  return 'text-amber-500'
}

const gitStatusDotClass = (status: GitStatusKind) => {
  if (status === 'added') {
    return 'bg-emerald-500'
  }
  if (status === 'deleted') {
    return 'bg-red-500'
  }
  return 'bg-amber-500'
}

const itemTextClass = (
  node: FileNode,
  itemStatus: GitStatusKind | undefined
) => {
  if (node.ignored) {
    return 'text-muted-foreground'
  }
  if (itemStatus !== undefined) {
    return gitStatusTextClass(itemStatus)
  }
  return 'text-foreground'
}

const collectChangedDirectories = (gitStatus: readonly GitStatusEntry[]) => {
  const changedDirectories = new Set<string>()

  for (const entry of gitStatus) {
    let slashIndex = entry.path.lastIndexOf('/')
    while (slashIndex !== -1) {
      changedDirectories.add(entry.path.slice(0, slashIndex))
      slashIndex = entry.path.lastIndexOf('/', slashIndex - 1)
    }
  }

  return changedDirectories
}

function TreeBranch({
  changedDirectories,
  gitStatusByPath,
  level,
  onContextMenuItem,
  onSelect,
  parentDir,
  selectedPath,
  store,
}: {
  readonly changedDirectories: ReadonlySet<string>
  readonly gitStatusByPath: ReadonlyMap<string, GitStatusKind>
  readonly level: number
  readonly onContextMenuItem: (item: TreeViewSelectionItem) => void
  readonly onSelect: (item: TreeViewSelectionItem) => void
  readonly parentDir: string
  readonly selectedPath: string | null
  readonly store: Pick<
    FileTreeStore,
    'children' | 'collapseDir' | 'expandDir' | 'isDirExpanded'
  >
}) {
  const children = store.children(parentDir)

  return children.map((node) => {
    const selectionItem: TreeViewSelectionItem = {
      path: node.path,
      type: node.type,
    }
    const itemStatus = gitStatusByPath.get(node.path)
    const isSelected = selectedPath === node.path

    if (node.type === 'directory') {
      const expanded = store.isDirExpanded(node.path)
      const hasChangedDescendant = changedDirectories.has(node.path)

      return (
        <Fragment key={node.path}>
          <button
            aria-expanded={expanded}
            aria-label={node.name}
            aria-selected={isSelected}
            className={cn(
              'group flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isSelected && 'bg-accent'
            )}
            data-file-path={node.path}
            data-testid="file-tree-item"
            data-tree-item="true"
            onClick={() => {
              onSelect(selectionItem)
              if (expanded) {
                store.collapseDir(node.path)
                return
              }
              store.expandDir(node.path)
            }}
            onContextMenuCapture={() => {
              onSelect(selectionItem)
              onContextMenuItem(selectionItem)
            }}
            role="treeitem"
            style={{ paddingLeft: `${8 + level * 12}px` }}
            type="button"
          >
            <ChevronRight
              className={cn(
                'size-4 shrink-0 text-muted-foreground transition-transform',
                expanded && 'rotate-90'
              )}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-medium text-xs',
                node.ignored ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {node.name}
            </span>
            {hasChangedDescendant && (
              <div
                className={cn(
                  'mr-1.5 size-1.5 shrink-0 rounded-full',
                  gitStatusDotClass('modified')
                )}
              />
            )}
          </button>
          {expanded && (
            <div>
              <TreeBranch
                changedDirectories={changedDirectories}
                gitStatusByPath={gitStatusByPath}
                level={level + 1}
                onContextMenuItem={onContextMenuItem}
                onSelect={onSelect}
                parentDir={node.path}
                selectedPath={selectedPath}
                store={store}
              />
            </div>
          )}
        </Fragment>
      )
    }

    return (
      <button
        aria-label={node.name}
        aria-selected={isSelected}
        className={cn(
          'group flex h-6 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isSelected && 'bg-accent'
        )}
        data-file-path={node.path}
        data-git-status={itemStatus}
        data-testid="file-tree-item"
        data-tree-item="true"
        key={node.path}
        onClick={() => {
          onSelect(selectionItem)
        }}
        onContextMenuCapture={() => {
          onSelect(selectionItem)
          onContextMenuItem(selectionItem)
        }}
        role="treeitem"
        style={{ paddingLeft: `${8 + level * 12}px` }}
        type="button"
      >
        <div className="w-4 shrink-0" />
        {renderFileIcon(node, itemStatus)}
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-medium text-xs',
            itemTextClass(node, itemStatus)
          )}
        >
          {node.name}
        </span>
        {itemStatus !== undefined && (
          <span
            className={cn(
              'w-4 shrink-0 text-center font-medium text-xs',
              gitStatusTextClass(itemStatus)
            )}
          >
            {gitStatusLabel(itemStatus)}
          </span>
        )}
      </button>
    )
  })
}

function renderFileIcon(node: FileNode, itemStatus: GitStatusKind | undefined) {
  if (node.ignored) {
    return <FileIcon className="text-muted-foreground" mono node={node} />
  }

  if (itemStatus !== undefined) {
    return (
      <FileIcon className={gitStatusTextClass(itemStatus)} mono node={node} />
    )
  }

  return (
    <span className="relative size-4 shrink-0">
      <FileIcon
        className="absolute inset-0 opacity-0 transition-opacity group-hover:opacity-100"
        node={node}
      />
      <FileIcon
        className="absolute inset-0 text-muted-foreground transition-opacity group-hover:opacity-0"
        mono
        node={node}
      />
    </span>
  )
}

export function FileTreeView({
  gitStatus,
  onContextMenuItem,
  onSelect,
  selectedPath,
  store,
}: FileTreeViewProps) {
  const gitStatusByPath = useMemo(
    () =>
      new Map(gitStatus.map((entry) => [entry.path, entry.status] as const)),
    [gitStatus]
  )
  const changedDirectories = useMemo(
    () => collectChangedDirectories(gitStatus),
    [gitStatus]
  )

  return (
    <div className="flex flex-col gap-0.5 p-1" role="tree">
      <TreeBranch
        changedDirectories={changedDirectories}
        gitStatusByPath={gitStatusByPath}
        level={0}
        onContextMenuItem={onContextMenuItem}
        onSelect={onSelect}
        parentDir=""
        selectedPath={selectedPath}
        store={store}
      />
    </div>
  )
}

export { collectChangedDirectories }
