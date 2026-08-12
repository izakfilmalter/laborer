/**
 * Project group component for the sidebar.
 *
 * Renders a single project as a collapsible heading with its workspaces.
 * The heading shows the project name, a chevron toggle, and project
 * settings/delete actions.
 *
 * @see Issue #168: ProjectGroup collapsible headings with nested workspaces
 * @see Issue #169: Per-project "+" button and CreateWorkspaceForm pre-selection
 * @see Issue #173: Polish and verification
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { ChevronRight, FolderGit2, Plus, Trash2 } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  CreateWorkspaceForm,
  type PendingWorkspaceCreation,
  type PendingWorkspaceCreationChangeHandler,
} from '@/components/create-workspace-form'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { ProjectSettingsModal } from '@/components/project-settings-modal'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceList } from '@/components/workspace-list'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { toast } from '@/lib/toast'
import { cn, extractErrorMessage } from '@/lib/utils'

const removeProjectMutation = LaborerClient.mutation('project.remove')

interface ProjectGroupProps {
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly project: {
    readonly id: string
    readonly name: string
    readonly repoPath: string
  }
}

function ProjectGroup({ project, expanded, onToggle }: ProjectGroupProps) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [pendingWorkspaceCreations, setPendingWorkspaceCreations] = useState<
    readonly PendingWorkspaceCreation[]
  >([])
  const pendingCreationIdsRef = useRef(new Set<string>())
  const removeProject = useAtomSet(removeProjectMutation, {
    mode: 'promise',
  })

  const handlePendingCreationChange: PendingWorkspaceCreationChangeHandler =
    useCallback(
      ({ creation, id }) => {
        if (creation === null) {
          pendingCreationIdsRef.current.delete(id)
          setPendingWorkspaceCreations((current) =>
            current.filter((pending) => pending.id !== id)
          )
          return
        }

        const isNewCreation = !pendingCreationIdsRef.current.has(id)
        pendingCreationIdsRef.current.add(id)
        setPendingWorkspaceCreations((current) => {
          const alreadyPending = current.some((pending) => pending.id === id)
          if (!alreadyPending) {
            return [...current, creation]
          }
          return current.map((pending) =>
            pending.id === id ? creation : pending
          )
        })

        if (isNewCreation && !expanded) {
          onToggle()
        }
      },
      [expanded, onToggle]
    )

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
            onPendingCreationChange={handlePendingCreationChange}
            projectId={project.id}
            projectName={project.name}
            trigger={
              <Tooltip>
                <TooltipTrigger
                  render={
                    <DialogTrigger
                      render={
                        <Button
                          aria-label={`Create workspace in ${project.name}`}
                          className="h-7 w-7"
                          disabled={!isServerReady}
                          size="icon-sm"
                          title={
                            isServerReady
                              ? undefined
                              : 'Connecting to server...'
                          }
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
                        disabled={!isServerReady}
                        size="icon-sm"
                        title={
                          isServerReady ? undefined : 'Connecting to server...'
                        }
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
          <WorkspaceList
            onPendingCreationChange={handlePendingCreationChange}
            pendingCreations={pendingWorkspaceCreations}
            projectId={project.id}
            projectName={project.name}
            repoPath={project.repoPath}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export { ProjectGroup }
export type { ProjectGroupProps }
