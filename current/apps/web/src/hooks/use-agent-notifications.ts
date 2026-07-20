/**
 * Desktop notification hook for agent status transitions.
 *
 * Watches terminal list polling for workspace-level agent status changes.
 * When a workspace transitions from 'active' → 'waiting_for_input',
 * fires an Electron desktop notification (via DesktopBridge). Clicking
 * the notification focuses the app window and invokes the provided
 * `onWorkspaceClicked` callback so the caller can activate that workspace's pane.
 *
 * Notifications are only sent when the window is not focused (background),
 * so they don't interrupt active use.
 *
 * In browser mode (no Electron), the hook is a no-op.
 *
 * @see packages/shared/src/desktop-bridge.ts — sendNotification / onNotificationClicked
 * @see apps/web/src/lib/agent-notification-transitions.ts — transition detection
 */

import { useEffect, useRef } from 'react'

import type { AgentStatus, TerminalInfo } from '@/hooks/use-terminal-list'
import { detectNotificationTransitions } from '@/lib/agent-notification-transitions'
import { getDesktopBridge } from '@/lib/desktop'
import { haptics } from '@/lib/haptics'
import { deriveWorkspaceAgentStatus } from '@/lib/workspace-agent-status'

/** Workspace metadata needed to compose notification titles. */
interface WorkspaceInfo {
  readonly branchName: string
  readonly id: string
}

/**
 * Derive per-workspace aggregate agent status from a terminal list.
 * Groups terminals by workspaceId and applies deriveWorkspaceAgentStatus.
 */
function buildWorkspaceStatusMap(
  terminals: readonly TerminalInfo[]
): Map<string, AgentStatus> {
  // Group terminals by workspace
  const grouped = new Map<string, TerminalInfo[]>()
  for (const terminal of terminals) {
    const existing = grouped.get(terminal.workspaceId)
    if (existing) {
      existing.push(terminal)
    } else {
      grouped.set(terminal.workspaceId, [terminal])
    }
  }

  // Derive aggregate status per workspace
  const statusMap = new Map<string, AgentStatus>()
  for (const [workspaceId, workspaceTerminals] of grouped) {
    const status = deriveWorkspaceAgentStatus(workspaceTerminals)
    if (status !== null) {
      statusMap.set(workspaceId, status)
    }
  }

  return statusMap
}

/**
 * Watch terminal list for agent status transitions and send desktop
 * notifications when an agent finishes / needs input.
 *
 * @param terminals - Current terminal list from useTerminalList
 * @param workspaces - Workspace metadata for composing notification titles
 * @param onWorkspaceClicked - Callback when user clicks a notification (receives workspaceId)
 */
function useAgentNotifications(
  terminals: readonly TerminalInfo[],
  workspaces: readonly WorkspaceInfo[],
  onWorkspaceClicked?: (workspaceId: string) => void
): void {
  const prevStatusMapRef = useRef<Map<string, AgentStatus>>(new Map())
  const onWorkspaceClickedRef = useRef(onWorkspaceClicked)
  onWorkspaceClickedRef.current = onWorkspaceClicked

  // Subscribe to notification click events from the Electron main process
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    const unsubscribe = bridge.onNotificationClicked((workspaceId) => {
      onWorkspaceClickedRef.current?.(workspaceId)
    })

    return unsubscribe
  }, [])

  // Detect transitions and send notifications
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge) {
      return
    }

    const currentStatusMap = buildWorkspaceStatusMap(terminals)
    const transitioned = detectNotificationTransitions(
      prevStatusMapRef.current,
      currentStatusMap
    )

    // Update the ref for next comparison
    prevStatusMapRef.current = currentStatusMap

    if (transitioned.length === 0) {
      return
    }

    // Play haptic nudge for any attention-needed transition (even when focused)
    haptics.notification()

    // Only send desktop notifications when the window is not focused
    if (document.hasFocus()) {
      return
    }

    // Build workspace lookup for notification titles
    const workspaceLookup = new Map(workspaces.map((ws) => [ws.id, ws]))

    for (const workspaceId of transitioned) {
      const workspace = workspaceLookup.get(workspaceId)
      const title = workspace?.branchName ?? 'Workspace'

      bridge
        .sendNotification({
          title,
          body: 'Agent is waiting for input',
          workspaceId,
        })
        .catch(() => {
          // Silently ignore — notifications may not be available
        })
    }
  }, [terminals, workspaces])
}

export { buildWorkspaceStatusMap, useAgentNotifications }
export type { WorkspaceInfo }
