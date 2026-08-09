/**
 * Pure function for detecting agent notification-worthy transitions.
 *
 * Compares previous and current per-workspace agent status maps to
 * determine which workspaces just transitioned from 'working' to
 * 'needs_input' — the trigger for a desktop notification.
 *
 * Only the `working` → `needs_input` transition fires a notification.
 * Other transitions (null → waiting, waiting → waiting, active → null)
 * are not notification-worthy because they either represent stale state
 * or clearing of the agent.
 *
 * @see apps/web/src/hooks/use-agent-notifications.ts — hook consumer
 */

import type { AgentStatus } from '@/hooks/use-terminal-list'

/**
 * Detect workspaces that just transitioned to needing user input.
 *
 * @param prev - Previous per-workspace aggregate agent status
 * @param curr - Current per-workspace aggregate agent status
 * @returns Array of workspace IDs that transitioned working → needs_input
 */
function detectNotificationTransitions(
  prev: ReadonlyMap<string, AgentStatus>,
  curr: ReadonlyMap<string, AgentStatus>
): string[] {
  const result: string[] = []

  for (const [workspaceId, currentStatus] of curr) {
    if (currentStatus !== 'needs_input') {
      continue
    }

    const previousStatus = prev.get(workspaceId)
    if (previousStatus === 'working') {
      result.push(workspaceId)
    }
  }

  return result
}

export { detectNotificationTransitions }
