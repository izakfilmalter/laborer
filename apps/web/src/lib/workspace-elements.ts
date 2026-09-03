/**
 * Finds the visible DOM container for a workspace-scoped overlay.
 *
 * Inactive window tabs stay mounted with `display: none`, so matching by
 * workspace ID alone can select a hidden copy. A fullscreen workspace also
 * keeps its inline frame mounted underneath the fullscreen surface, so that
 * surface must take precedence when present. Minimized frames are visible but
 * too short to host a usable overlay, so they are excluded as well.
 */

function findVisibleWorkspaceElement(
  kind: 'frame' | 'fullscreen',
  workspaceId?: string
): HTMLElement | null {
  if (typeof document === 'undefined') {
    return null
  }

  const elements = document.querySelectorAll<HTMLElement>(
    `[data-workspace-overlay-container="${kind}"]`
  )

  for (const element of elements) {
    if (
      (workspaceId === undefined ||
        element.dataset.workspaceId === workspaceId) &&
      element.dataset.workspaceMinimized !== 'true' &&
      element.getClientRects().length > 0
    ) {
      return element
    }
  }

  return null
}

export function findVisibleWorkspaceFrameElement(
  workspaceId: string
): HTMLElement | null {
  return findVisibleWorkspaceElement('frame', workspaceId)
}

export function findWorkspaceCommandPaletteContainer(
  workspaceId: string
): HTMLElement | null {
  return (
    findVisibleWorkspaceElement('fullscreen') ??
    findVisibleWorkspaceFrameElement(workspaceId)
  )
}
