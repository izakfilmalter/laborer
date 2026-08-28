interface FileTreeDragTransfer {
  setData(format: string, data: string): void
}

export interface FileTreeDragStartEvent {
  composedPath(): readonly unknown[]
  readonly dataTransfer: FileTreeDragTransfer | null
}

export const COMPOSER_MENTION_DRAG_TYPE =
  'application/x-t3code-composer-mention'
const TRAILING_SLASHES = /\/+$/

const basename = (path: string): string =>
  path.replace(TRAILING_SLASHES, '').split('/').at(-1) ?? path

export function serializeFileMention(path: string): string {
  const relativePath = path.replace(TRAILING_SLASHES, '')
  const label = basename(relativePath)
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
  const destination = encodeURI(relativePath)
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('#', '%23')
    .replaceAll('?', '%3F')
    .replaceAll('\\', '%5C')
  return `[${label}](${destination})`
}

const itemPathOf = (node: unknown): string | null => {
  if (typeof node !== 'object' || node === null) {
    return null
  }
  const element = node as {
    getAttribute?: (name: string) => string | null
  }
  return typeof element.getAttribute === 'function'
    ? element.getAttribute('data-item-path')
    : null
}

export function createFileTreeDragMentionController(host: {
  deselect(treePath: string): void
}) {
  let selection: readonly string[] = []
  let draggedPaths: readonly string[] = []
  return {
    isDragInProgress: () => draggedPaths.length > 0,
    handleSelectionChange(selectedPaths: readonly string[]) {
      selection = selectedPaths
    },
    handleDragStart(event: FileTreeDragStartEvent) {
      if (event.dataTransfer === null) {
        return
      }
      const itemPath = event.composedPath().map(itemPathOf).find(Boolean)
      if (!itemPath) {
        return
      }
      const dragged = selection.includes(itemPath) ? selection : [itemPath]
      const mentions = dragged
        .map((path) => path.replace(TRAILING_SLASHES, ''))
        .filter(Boolean)
        .map(serializeFileMention)
      if (mentions.length === 0) {
        return
      }
      draggedPaths = dragged
      event.dataTransfer.setData(COMPOSER_MENTION_DRAG_TYPE, mentions.join(' '))
    },
    handleDragEnd() {
      for (const path of draggedPaths) {
        host.deselect(path)
      }
      draggedPaths = []
    },
  }
}
