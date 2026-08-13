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
import { ChevronRight, FolderGit2, Trash2 } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  clearProjectRemoveOverlayAtom,
  installProjectRemoveOverlayAtom,
} from '@/atoms/shared-state'
import {
  CreateWorkspaceButton,
  CreateWorkspaceComposer,
} from '@/components/create-workspace-composer'
import type { ComposerCloseReason } from '@/components/inline-composer'
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { WorkspaceList } from '@/components/workspace-list'
import type {
  PendingWorkspaceCreation,
  PendingWorkspaceCreationChangeHandler,
} from '@/hooks/use-create-workspace'
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
  const [composerOpen, setComposerOpen] = useState(false)
  const [pendingWorkspaceCreations, setPendingWorkspaceCreations] = useState<
    readonly PendingWorkspaceCreation[]
  >([])
  const pendingCreationIdsRef = useRef(new Set<string>())
  const groupId = useId()
  const composerId = `${groupId}-composer`
  const addButtonId = `${groupId}-add`
  const removeProject = useAtomSet(removeProjectMutation, {
    mode: 'promise',
  })
  const installRemoveOverlay = useAtomSet(installProjectRemoveOverlayAtom)
  const clearRemoveOverlay = useAtomSet(clearProjectRemoveOverlayAtom)

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

  const toggleComposer = () => {
    const nextOpen = !composerOpen
    setComposerOpen(nextOpen)
    // Opening the composer reveals where its workspace will land.
    if (nextOpen && !expanded) {
      onToggle()
    }
  }

  const closeComposer = (reason: ComposerCloseReason) => {
    setComposerOpen(false)
    if (reason === 'cancel') {
      document.getElementById(addButtonId)?.focus()
    }
  }

  const handleRemove = () => {
    // Optimistic: the group leaves the sidebar as soon as removal is
    // confirmed. The overlay settles when the authoritative project row is
    // deleted, and is restored if the server rejects the removal.
    setDialogOpen(false)
    installRemoveOverlay(project.id)
    removeProject({
      payload: { projectId: project.id },
    })
      .then(() => {
        toast.success(`Project "${project.name}" removed`)
      })
      .catch((error: unknown) => {
        clearRemoveOverlay(project.id)
        toast.error(extractErrorMessage(error))
      })
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
          <CreateWorkspaceButton
            composerId={composerId}
            disabled={!isServerReady}
            id={addButtonId}
            onToggle={toggleComposer}
            open={composerOpen}
            projectName={project.name}
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
                <AlertDialogAction onClick={handleRemove} variant="destructive">
                  Remove
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
      {composerOpen && (
        // Outside the collapsible so the composer survives a collapse mid-typing.
        <div className="ml-2 border-l pt-1 pl-2">
          <CreateWorkspaceComposer
            composerId={composerId}
            onClose={closeComposer}
            onPendingCreationChange={handlePendingCreationChange}
            projectId={project.id}
            projectName={project.name}
          />
        </div>
      )}
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
