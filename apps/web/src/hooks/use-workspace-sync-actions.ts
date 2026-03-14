import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { extractErrorMessage } from '@/lib/utils'

const pushWorkspaceMutation = LaborerClient.mutation('workspace.push')
const pullWorkspaceMutation = LaborerClient.mutation('workspace.pull')

function useWorkspaceSyncActions() {
  const pushWorkspace = useAtomSet(pushWorkspaceMutation, { mode: 'promise' })
  const pullWorkspace = useAtomSet(pullWorkspaceMutation, { mode: 'promise' })

  const handlePush = useCallback(
    async (workspaceId: string) => {
      const toastId = toast.loading('Pushing commits...')

      try {
        const result = await pushWorkspace({ payload: { workspaceId } })
        const pushedCount = result.aheadCount ?? 0
        toast.success(
          pushedCount === 0
            ? 'Push complete'
            : `Pushed ${pushedCount} commit${pushedCount === 1 ? '' : 's'}`,
          { id: toastId }
        )
      } catch (error: unknown) {
        toast.error(`Failed to push commits: ${extractErrorMessage(error)}`, {
          id: toastId,
        })
      }
    },
    [pushWorkspace]
  )

  const handlePull = useCallback(
    async (workspaceId: string) => {
      const toastId = toast.loading('Pulling commits...')

      try {
        const result = await pullWorkspace({ payload: { workspaceId } })
        const pulledCount = result.behindCount ?? 0
        toast.success(
          pulledCount === 0
            ? 'Pull complete'
            : `Pulled ${pulledCount} commit${pulledCount === 1 ? '' : 's'}`,
          { id: toastId }
        )
      } catch (error: unknown) {
        toast.error(`Failed to pull commits: ${extractErrorMessage(error)}`, {
          id: toastId,
        })
      }
    },
    [pullWorkspace]
  )

  return {
    pullWorkspace: handlePull,
    pushWorkspace: handlePush,
  }
}

export { useWorkspaceSyncActions }
