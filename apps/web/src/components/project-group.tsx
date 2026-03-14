/**
 * Project group component for the sidebar.
 *
 * Renders a single project as a collapsible heading with its workspaces
 * and tasks nested underneath. The heading shows the project name, a chevron
 * toggle, and project settings/delete actions.
 *
 * Task source selection (Linear/GitHub) is managed independently
 * per project via local state.
 *
 * @see Issue #168: ProjectGroup collapsible headings with nested workspaces
 * @see Issue #169: Per-project "+" button and CreateWorkspaceForm pre-selection
 * @see Issue #170: Tasks nested under each project
 * @see Issue #173: Polish and verification
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { ChevronRight, FolderGit2, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { CreateWorkspaceForm } from '@/components/create-workspace-form'
import { PlanList } from '@/components/plan-list'
import { ProjectSettingsModal } from '@/components/project-settings-modal'
import { TaskList } from '@/components/task-list'
import { TaskSourcePicker } from '@/components/task-source-picker'
import type { TaskSourceFilter } from '@/components/task-source-picker.helpers'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { DialogTrigger } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceList } from '@/components/workspace-list'
import { cn, extractErrorMessage } from '@/lib/utils'

const removeProjectMutation = LaborerClient.mutation('project.remove')

interface ProjectGroupProps {
  readonly expanded: boolean
  readonly onSelectPlan?: ((prdId: string) => void) | undefined
  readonly onToggle: () => void
  readonly project: {
    readonly id: string
    readonly name: string
    readonly repoPath: string
    readonly brrrConfig: string | null
  }
  readonly selectedPlanId?: string | null | undefined
}

function ProjectGroup({
  project,
  expanded,
  onToggle,
  selectedPlanId,
  onSelectPlan,
}: ProjectGroupProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [taskSource, setTaskSource] = useState<TaskSourceFilter>('linear')
  const removeProject = useAtomSet(removeProjectMutation, {
    mode: 'promise',
  })

  const handleRemove = async () => {
    setIsRemoving(true)
    try {
      await removeProject({
        payload: { projectId: project.id },
      })
      toast.success(`Project "${project.name}" removed`)
      setDialogOpen(false)
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(message)
      setIsRemoving(false)
    }
  }

  return (
    <Collapsible defaultOpen={expanded} open={expanded}>
      <div className="flex items-center gap-1">
        <CollapsibleTrigger
          className="flex flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left font-medium text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          onClick={onToggle}
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">{project.name}</span>
        </CollapsibleTrigger>
        <div className="flex shrink-0 items-center gap-0.5">
          <CreateWorkspaceForm
            projectId={project.id}
            trigger={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DialogTrigger
                      render={
                        <Button
                          aria-label={`Create workspace in ${project.name}`}
                          className="h-7 w-7"
                          size="icon-sm"
                          variant="ghost"
                        />
                      }
                    />
                  }
                >
                  <Plus className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>Create Workspace</TooltipContent>
              </Tooltip>
            }
          />
          <ProjectSettingsModal
            projectId={project.id}
            projectName={project.name}
          />
          <AlertDialog onOpenChange={setDialogOpen} open={dialogOpen}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <AlertDialogTrigger
                    render={
                      <Button
                        aria-label={`Remove project ${project.name}`}
                        className="h-7 w-7"
                        size="icon-sm"
                        variant="ghost"
                      />
                    }
                  />
                }
              >
                <Trash2 className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipContent>Remove project</TooltipContent>
            </Tooltip>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove project?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will unregister{' '}
                  <strong className="text-foreground">{project.name}</strong>{' '}
                  from Laborer. Existing workspaces and worktrees will not be
                  deleted from disk.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={isRemoving}
                  onClick={handleRemove}
                  variant="destructive"
                >
                  {isRemoving ? 'Removing...' : 'Remove'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      <CollapsibleContent>
        <div className="mt-1 ml-2 border-l pl-2">
          <WorkspaceList projectId={project.id} repoPath={project.repoPath} />
          <Separator className="my-2" />
          <PlanList
            onSelectPlan={onSelectPlan}
            projectId={project.id}
            selectedPlanId={selectedPlanId}
          />
          <Separator className="my-2" />
          <div className="grid gap-2">
            <h3 className="font-medium text-muted-foreground text-xs">Tasks</h3>
            <TaskSourcePicker
              activeSource={taskSource}
              onSourceChange={setTaskSource}
              projectId={project.id}
            />
            <TaskList projectId={project.id} sourceFilter={taskSource} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export { ProjectGroup }
export type { ProjectGroupProps }
