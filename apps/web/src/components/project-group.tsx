/**
 * Project group component for the sidebar.
 *
 * Renders a single project as a collapsible heading with its workspaces.
 * The heading shows the project name, a chevron toggle, and project
 * settings/delete actions.
 *
 * The heading is also the grab area that reorders the project — the stored
 * order is shared with the kanban swim lanes.
 *
 * @see Issue #168: ProjectGroup collapsible headings with nested workspaces
 * @see Issue #169: Per-project "+" button and CreateWorkspaceForm pre-selection
 * @see Issue #173: Polish and verification
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
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
} from '@laborer/ui/components/alert-dialog'
import { Button } from '@laborer/ui/components/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@laborer/ui/components/collapsible'
import { Kbd } from '@laborer/ui/components/kbd'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { ChevronRight, FolderGit2, Trash2 } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import { useCallback, useId, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import {
  CreateWorkspaceButton,
  CreateWorkspaceComposer,
} from '@/components/create-workspace-composer'
import type { ComposerCloseReason } from '@/components/inline-composer'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import {
  ProjectDragHandle,
  ProjectDropIndicator,
  useProjectDragItem,
} from '@/components/project-reorder'
import { ProjectSettingsModal } from '@/components/project-settings-modal'
import { WorkspaceList } from '@/components/workspace-list'
import { removeProject as removeProjectOptimistically } from '@/db/shared-mutations'
import type {
  PendingWorkspaceCreation,
  PendingWorkspaceCreationChangeHandler,
} from '@/hooks/use-create-workspace'
import { useProjectShortName } from '@/hooks/use-project-short-name'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { isExactEnter, isMetaEnter } from '@/lib/dialog-keys'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'

const removeProjectMutation = LaborerClient.mutation('project.remove')

interface ProjectGroupProps {
  readonly expanded: boolean
  /** Position in the rendered tree, which orients the drop indicator. */
  readonly index: number
  readonly onToggle: () => void
  readonly project: {
    readonly id: string
    readonly name: string
    readonly rootPath: string
  }
  /** False while a search filters the tree, where a drop slot is ambiguous. */
  readonly reorderEnabled: boolean
}

function ProjectGroup({
  project,
  expanded,
  index,
  onToggle,
  reorderEnabled,
}: ProjectGroupProps) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const projectShortName = useProjectShortName(project.id)
  const groupRef = useRef<HTMLDivElement | null>(null)
  const headingRef = useRef<HTMLDivElement | null>(null)
  // An order written before the server is up cannot be stored, so the group
  // only becomes draggable alongside its other write actions.
  const canReorder = reorderEnabled && isServerReady
  const { closestEdge, isDragging } = useProjectDragItem({
    dragHandleRef: headingRef,
    elementRef: groupRef,
    enabled: canReorder,
    index,
    projectId: project.id,
    surface: 'sidebar',
  })
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
    // confirmed. TanStack retains the deletion through RPC success and rolls
    // it back if the server definitively rejects the removal.
    setDialogOpen(false)
    removeProjectOptimistically({
      operationId: crypto.randomUUID(),
      projectId: project.id,
      send: (payload) => removeProject({ payload }),
    })
      .then(() => {
        toast.success(`Project "${project.name}" removed`)
      })
      .catch((error: unknown) => {
        toast.error(extractErrorMessage(error))
      })
  }

  return (
    <div
      className={cn(
        'group/project relative transition-opacity',
        isDragging && 'opacity-40'
      )}
      data-project-id={project.id}
      data-testid="project-group"
      ref={groupRef}
    >
      <ProjectDropIndicator edge={closestEdge} />
      <Collapsible defaultOpen={expanded} open={expanded}>
        <div className="flex items-center gap-1" ref={headingRef}>
          <ProjectDragHandle
            disabled={!canReorder}
            projectId={project.id}
            projectName={project.name}
          />
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
            <span className="min-w-0 flex-1 truncate" title={project.rootPath}>
              {project.name}
            </span>
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
                  <Trash2 className="size-3.5 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>Remove project</TooltipContent>
              </Tooltip>
              <AlertDialogContent
                data-testid="remove-project-dialog"
                onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                  if (isExactEnter(event.nativeEvent)) {
                    event.preventDefault()
                    return
                  }

                  if (isMetaEnter(event.nativeEvent)) {
                    event.preventDefault()
                    handleRemove()
                  }
                }}
              >
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
                  <AlertDialogCancel>
                    Cancel <Kbd>Esc</Kbd>
                  </AlertDialogCancel>
                  <AlertDialogAction
                    data-testid="confirm-remove-project"
                    onClick={handleRemove}
                    variant="destructive"
                  >
                    Remove
                    <Kbd>⌘</Kbd>
                    <Kbd>↵</Kbd>
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
        {composerOpen && (
          // Outside the collapsible so the composer survives a collapse mid-typing.
          <div className="pt-1">
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
          {/* No indent: the cards hold the sidebar's outer rail, the same one
              the search field sits on. The heading's own inset comes from its
              drag-handle gutter, which reads as a header treatment rather than
              a level of nesting for the cards to step in from. */}
          <div className="mt-1">
            <WorkspaceList
              onPendingCreationChange={handlePendingCreationChange}
              pendingCreations={pendingWorkspaceCreations}
              projectId={project.id}
              projectName={project.name}
              projectShortName={projectShortName}
              rootPath={project.rootPath}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export { ProjectGroup }
export type { ProjectGroupProps }
