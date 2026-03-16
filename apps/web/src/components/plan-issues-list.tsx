/**
 * Issues list component for the plan detail view.
 *
 * Displays a reactive list of tasks linked to a specific PRD from LiveStore.
 * Renders alongside the PlanEditor, showing all issues for a PRD with
 * status indicators and inline status dropdowns matching TaskList styling.
 *
 * @see Issue #191: Plan detail view: issues list alongside editor
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { tasks } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import {
  CheckCircle2,
  Circle,
  ClipboardList,
  Loader2,
  XCircle,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn, extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'

const allTasks$ = queryDb(tasks, { label: 'planIssuesList.tasks' })
const updateTaskStatusMutation = LaborerClient.mutation('task.updateStatus')

type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

const STATUS_OPTIONS: readonly {
  readonly value: TaskStatus
  readonly label: string
}[] = [
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
]

/**
 * Returns Tailwind classes for a task status badge.
 */
function getStatusClasses(status: string): string {
  switch (status as TaskStatus) {
    case 'pending':
      return 'border-warning/30 bg-warning/10 text-warning'
    case 'in_progress':
      return 'border-info/30 bg-info/10 text-info'
    case 'completed':
      return 'border-success/30 bg-success/10 text-success'
    case 'cancelled':
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
    default:
      return 'border-muted-foreground/30 bg-muted text-muted-foreground'
  }
}

/**
 * Returns a status icon component for the given task status.
 */
function StatusIcon({ status }: { readonly status: string }) {
  switch (status as TaskStatus) {
    case 'pending':
      return <Circle className="size-3.5 text-warning" />
    case 'in_progress':
      return <Loader2 className="size-3.5 animate-spin text-info" />
    case 'completed':
      return <CheckCircle2 className="size-3.5 text-success" />
    case 'cancelled':
      return <XCircle className="size-3.5 text-muted-foreground" />
    default:
      return <Circle className="size-3.5 text-muted-foreground" />
  }
}

/**
 * Format a status string for display (e.g. "in_progress" -> "in progress").
 */
function formatStatus(status: string): string {
  return status.replace(/_/g, ' ')
}

interface PlanIssueItemProps {
  readonly task: {
    readonly id: string
    readonly title: string
    readonly status: string
    readonly externalId: string | null
  }
}

function PlanIssueItem({ task }: PlanIssueItemProps) {
  const [isUpdating, setIsUpdating] = useState(false)

  const updateTaskStatus = useAtomSet(updateTaskStatusMutation, {
    mode: 'promise',
  })

  const handleStatusChange = async (newStatus: string | null) => {
    if (!newStatus || newStatus === task.status) {
      return
    }
    setIsUpdating(true)
    try {
      await updateTaskStatus({
        payload: { taskId: task.id, status: newStatus },
      })
      toast.success(`Issue status updated to "${formatStatus(newStatus)}"`)
    } catch (error: unknown) {
      toast.error(`Failed to update issue: ${extractErrorMessage(error)}`)
    } finally {
      setIsUpdating(false)
    }
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <StatusIcon status={task.status} />
          <span className="truncate text-sm">{task.title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Select
            disabled={isUpdating}
            onValueChange={handleStatusChange}
            value={task.status}
          >
            <SelectTrigger
              className={cn(
                'h-7 w-auto gap-1.5 border px-2 text-xs',
                getStatusClasses(task.status)
              )}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <div className="flex items-center gap-1.5">
                    <StatusIcon status={option.value} />
                    {option.label}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {task.externalId && (
            <span className="truncate font-mono text-muted-foreground text-xs">
              {task.externalId}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

interface PlanIssuesListProps {
  readonly prdId: string
}

function PlanIssuesList({ prdId }: PlanIssuesListProps) {
  const store = useLaborerStore()
  const taskList = store.useQuery(allTasks$)

  // Filter to only tasks linked to this PRD with source "prd",
  // preserving creation order (LiveStore returns in insertion order)
  const prdIssues = useMemo(
    () =>
      taskList.filter((task) => task.source === 'prd' && task.prdId === prdId),
    [taskList, prdId]
  )

  if (prdIssues.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ClipboardList />
          </EmptyMedia>
          <EmptyTitle>No issues</EmptyTitle>
          <EmptyDescription>
            Create issues for this plan through the MCP tools or AI agent.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="grid gap-2">
      {prdIssues.map((task) => (
        <PlanIssueItem key={task.id} task={task} />
      ))}
    </div>
  )
}

export { PlanIssuesList }
