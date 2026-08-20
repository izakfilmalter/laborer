import { useAtomSet } from '@effect/atom-react/Hooks'
import { useCallback } from 'react'
import { toast } from 'sonner'
import {
  LaborerClient,
  workspaceSyncReactivityKeys,
} from '@/atoms/laborer-client'
import { extractErrorMessage } from '@/lib/errors'

const pushWorkspaceMutation = LaborerClient.mutation('workspace.push')
const pullWorkspaceMutation = LaborerClient.mutation('workspace.pull')

function useWorkspaceSyncActions() {
  const pushWorkspace = useAtomSet(pushWorkspaceMutation, { mode: 'promise' })
  const pullWorkspace = useAtomSet(pullWorkspaceMutation, { mode: 'promise' })

  // Progress and success are already legible where the action was taken: the
  // sync button spins while the call is in flight and the ahead/behind counts
  // drop when it lands. Only a failure needs a toast to explain itself.
  const handlePush = useCallback(
    async (workspaceId: string) => {
      try {
        await pushWorkspace({
          payload: { workspaceId },
          reactivityKeys: workspaceSyncReactivityKeys(workspaceId),
        })
      } catch (error: unknown) {
        toast.error(`Failed to push commits: ${extractErrorMessage(error)}`)
      }
    },
    [pushWorkspace]
  )

  const handlePull = useCallback(
    async (workspaceId: string) => {
      try {
        await pullWorkspace({
          payload: { workspaceId },
          reactivityKeys: workspaceSyncReactivityKeys(workspaceId),
        })
      } catch (error: unknown) {
        toast.error(`Failed to pull commits: ${extractErrorMessage(error)}`)
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
