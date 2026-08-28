/**
 * useWorkspaceGitActions — commit, push, and open a pull request.
 *
 * The three steps a branch takes to become a review request, as three calls
 * the caller can run alone or in sequence. Each one resolves or rejects, so a
 * chained run — commit, then push, then open — stops at the first failure
 * instead of reporting a pull request that was never created.
 *
 * @see apps/web/src/components/git-actions-control.tsx — the button
 * @see packages/server/src/services/workspace-sync-service.ts — the git side
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { useCallback } from 'react'
import {
  LaborerClient,
  workspaceSyncReactivityKeys,
} from '@/atoms/laborer-client'

const commitWorkspaceMutation = LaborerClient.mutation('workspace.commit')
const createPrMutation = LaborerClient.mutation('workspace.createPr')
const pushWorkspaceMutation = LaborerClient.mutation('workspace.push')

function useWorkspaceGitActions() {
  const commitMutation = useAtomSet(commitWorkspaceMutation, {
    mode: 'promise',
  })
  const createPrMutationSet = useAtomSet(createPrMutation, { mode: 'promise' })
  const pushMutation = useAtomSet(pushWorkspaceMutation, { mode: 'promise' })

  /**
   * Commit the worktree, letting the server write the message when none is
   * given. An empty string is the same as none: the dialog leaves the field
   * blank by default, and a blank field means "you write it".
   */
  const commitWorkspace = useCallback(
    async (workspaceId: string, message?: string) => {
      const trimmed = message?.trim() ?? ''
      await commitMutation({
        payload:
          trimmed === '' ? { workspaceId } : { message: trimmed, workspaceId },
        reactivityKeys: workspaceSyncReactivityKeys(workspaceId),
      })
    },
    [commitMutation]
  )

  /** Open the pull request and hand back what the server read off it. */
  const createPullRequest = useCallback(
    async (workspaceId: string) =>
      await createPrMutationSet({
        payload: { workspaceId },
        reactivityKeys: workspaceSyncReactivityKeys(workspaceId),
      }),
    [createPrMutationSet]
  )

  /**
   * Push, and let the failure through.
   *
   * The sync button's push swallows its error into a toast, which is right
   * for a single step and wrong for a chain: a push that failed must stop the
   * pull request that was going to follow it.
   */
  const pushWorkspace = useCallback(
    async (workspaceId: string) => {
      await pushMutation({
        payload: { workspaceId },
        reactivityKeys: workspaceSyncReactivityKeys(workspaceId),
      })
    },
    [pushMutation]
  )

  return { commitWorkspace, createPullRequest, pushWorkspace }
}

export { useWorkspaceGitActions }
