import { prds, tasks } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { ChevronRight, ClipboardList, FileText } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'

const allPrds$ = queryDb(prds, { label: 'planList.prds' })
const allTasks$ = queryDb(tasks, { label: 'planList.tasks' })

interface PlanListProps {
  readonly onSelectPlan?: ((prdId: string) => void) | undefined
  readonly projectId: string
  readonly selectedPlanId?: string | null | undefined
}

interface PlanProgress {
  readonly completed: number
  readonly total: number
}

function computePlanProgress(
  projectTasks: ReadonlyArray<{
    readonly prdId: string | null
    readonly source: string
    readonly status: string
  }>,
  prdId: string
): PlanProgress {
  let total = 0
  let completed = 0

  for (const task of projectTasks) {
    if (task.source !== 'prd' || task.prdId !== prdId) {
      continue
    }

    total++
    if (task.status === 'completed') {
      completed++
    }
  }

  return { completed, total }
}

function PlanList({
  projectId,
  selectedPlanId: externalSelectedPlanId,
  onSelectPlan,
}: PlanListProps) {
  const store = useLaborerStore()
  const prdList = store.useQuery(allPrds$)
  const taskList = store.useQuery(allTasks$)
  const [expanded, setExpanded] = useState(true)
  const [localSelectedPlanId, setLocalSelectedPlanId] = useState<string | null>(
    null
  )

  // Use external selection if provided, otherwise fall back to local state
  const selectedPlanId = externalSelectedPlanId ?? localSelectedPlanId

  const plans = useMemo(() => {
    const projectTasks = taskList.filter((task) => task.projectId === projectId)

    return prdList
      .filter((prd) => prd.projectId === projectId)
      .map((prd) => ({
        ...prd,
        progress: computePlanProgress(projectTasks, prd.id),
      }))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }, [prdList, projectId, taskList])

  return (
    <Collapsible onOpenChange={setExpanded} open={expanded}>
      <div className="grid gap-2">
        <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md px-1 py-1 text-left font-medium text-muted-foreground text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1">
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
          <span>Plans</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {plans.length === 0 ? (
            <Empty className="min-h-0 rounded-md border bg-muted/20 p-4">
              <EmptyHeader className="gap-1.5">
                <EmptyMedia variant="icon">
                  <ClipboardList />
                </EmptyMedia>
                <EmptyTitle>No plans</EmptyTitle>
                <EmptyDescription>
                  Create a PRD through the MCP flow to track plan progress here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-2">
              {plans.map((plan) => {
                const progressValue =
                  plan.progress.total === 0
                    ? 0
                    : (plan.progress.completed / plan.progress.total) * 100

                return (
                  <button
                    aria-pressed={selectedPlanId === plan.id}
                    className={cn(
                      'grid gap-2 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:border-border hover:bg-accent/40',
                      selectedPlanId === plan.id &&
                        'border-primary/40 bg-accent/50'
                    )}
                    key={plan.id}
                    onClick={() => {
                      if (onSelectPlan) {
                        onSelectPlan(plan.id)
                      } else {
                        setLocalSelectedPlanId(plan.id)
                      }
                    }}
                    type="button"
                  >
                    <div className="flex items-start gap-2">
                      <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-sm">
                          {plan.title}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {plan.progress.completed}/{plan.progress.total} done
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-1">
                      <Progress
                        aria-label={`${plan.title} progress`}
                        value={progressValue}
                      />
                      <p className="text-muted-foreground text-xs tabular-nums">
                        {plan.progress.total} issues
                      </p>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export { PlanList }
