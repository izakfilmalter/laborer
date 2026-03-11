/**
 * Create Workspace from Plan component.
 *
 * Renders a "Create Workspace" button in the plan detail view. On click,
 * calls `workspace.create` with the plan's project ID and a branch name
 * derived from the plan slug (`plan/<slug>`). The button is disabled with
 * a tooltip when a workspace already exists for the plan.
 *
 * Association is by convention: workspaces whose `branchName` matches
 * `plan/<slug>` are considered linked to the plan.
 *
 * @see Issue #192: Create workspace from plan
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { prds, workspaces } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { Layers } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'

const allPrds$ = queryDb(prds, { label: 'createPlanWorkspace.prds' })
const allWorkspaces$ = queryDb(workspaces, {
  label: 'createPlanWorkspace.workspaces',
})
const createWorkspaceMutation = LaborerClient.mutation('workspace.create')

interface CreatePlanWorkspaceProps {
  readonly prdId: string
}

/**
 * Derives the expected workspace branch name for a plan.
 */
function planBranchName(slug: string): string {
  return `plan/${slug}`
}

function CreatePlanWorkspace({ prdId }: CreatePlanWorkspaceProps) {
  const store = useLaborerStore()
  const prdList = store.useQuery(allPrds$)
  const workspaceList = store.useQuery(allWorkspaces$)
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createWorkspace = useAtomSet(createWorkspaceMutation, {
    mode: 'promise',
  })

  // Find the PRD record for this plan
  const prd = useMemo(
    () => prdList.find((p) => p.id === prdId),
    [prdList, prdId]
  )

  // Check if a workspace already exists for this plan (non-destroyed)
  const existingWorkspace = useMemo(() => {
    if (!prd) {
      return undefined
    }
    const expectedBranch = planBranchName(prd.slug)
    return workspaceList.find(
      (ws) =>
        ws.projectId === prd.projectId &&
        ws.branchName === expectedBranch &&
        ws.status !== 'destroyed'
    )
  }, [workspaceList, prd])

  const hasExistingWorkspace = existingWorkspace !== undefined

  const handleCreate = async () => {
    if (!prd || hasExistingWorkspace) {
      return
    }

    setIsCreating(true)
    setError(null)

    try {
      const branchName = planBranchName(prd.slug)
      const result = await createWorkspace({
        payload: {
          projectId: prd.projectId,
          branchName,
        },
      })
      // The RPC now returns immediately with status 'creating'.
      // The workspace card will show setup progress via worktreeSetupStep.
      toast.success(
        `Workspace "${result.branchName}" is being set up (port ${result.port})`
      )
    } catch (err: unknown) {
      const message = extractErrorMessage(err)
      setError(message)
      toast.error(message)
    } finally {
      setIsCreating(false)
    }
  }

  if (!prd) {
    return null
  }

  // Disabled state: workspace already exists
  if (hasExistingWorkspace) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button disabled size="sm" variant="outline">
              <Layers className="size-3.5" />
              Create Workspace
            </Button>
          }
        />
        <TooltipContent>
          A workspace already exists for this plan (
          {existingWorkspace.branchName})
        </TooltipContent>
      </Tooltip>
    )
  }

  // Creating state: show spinner
  if (isCreating) {
    return (
      <Button disabled size="sm" variant="outline">
        <Spinner className="size-3.5" />
        Creating...
      </Button>
    )
  }

  // Ready state: create button
  return (
    <div className="grid gap-1.5">
      <Button onClick={handleCreate} size="sm" variant="outline">
        <Layers className="size-3.5" />
        Create Workspace
      </Button>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}

export { CreatePlanWorkspace, planBranchName }
