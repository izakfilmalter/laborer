import type { Project } from '@laborer/contracts/projects'
import { formatDistanceToNow } from 'date-fns'
import {
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuItem,
  SidebarMenuSubButton,
  SidebarSeparator,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { isElectron } from '@/env'
import { cn } from '@/lib/utils'
import {
  setActiveWorkspaceId,
  useActiveWorkspaceId,
  useProjectsSnapshot,
  useProjectsSyncReady,
} from '@/rpc/project-state'
import { getWsRpcClient } from '@/ws-rpc-client'

const APP_NAME = 'Laborer'
const APP_STAGE_LABEL = 'Alpha'
const PROJECT_EXPANSION_STORAGE_KEY = 'laborer:sidebar-project-expansion:v1'

interface PersistedProjectExpansionState {
  readonly expandedProjectWorkspaceRoots: readonly string[]
}

function resolveWorkspaceRowClassName(input: {
  isActive: boolean
  isSelected: boolean
}) {
  const baseClassName =
    'h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring'

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      'bg-primary/22 font-medium text-foreground hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36'
    )
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      'bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28'
    )
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      'bg-accent/85 font-medium text-foreground hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70'
    )
  }

  return cn(
    baseClassName,
    'text-muted-foreground hover:bg-accent hover:text-foreground'
  )
}

function formatUpdatedLabel(updatedAt: string) {
  return formatDistanceToNow(new Date(updatedAt), { addSuffix: true })
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return 'Something went wrong while talking to the Laborer server.'
}

function normalizeWorkspaceNameInput(value: string) {
  return value
    .toLowerCase()
    .split('/')
    .map((segment) =>
      segment
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9_-]/g, '')
        .replace(/^[-_]+|[-_]+$/g, '')
    )
    .filter((segment) => segment.length > 0)
    .join('/')
}

function readPersistedExpandedProjectWorkspaceRoots(): Set<string> | null {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const raw = window.localStorage.getItem(PROJECT_EXPANSION_STORAGE_KEY)

    if (!raw) {
      return null
    }

    const parsed = JSON.parse(raw) as unknown

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('expandedProjectWorkspaceRoots' in parsed) ||
      !Array.isArray(parsed.expandedProjectWorkspaceRoots)
    ) {
      return null
    }

    const expandedProjectWorkspaceRoots =
      parsed.expandedProjectWorkspaceRoots.filter(
        (projectWorkspaceRoot): projectWorkspaceRoot is string =>
          typeof projectWorkspaceRoot === 'string' &&
          projectWorkspaceRoot.length > 0
      )

    return new Set(expandedProjectWorkspaceRoots)
  } catch {
    return null
  }
}

function persistExpandedProjectWorkspaceRoots(input: {
  currentProjectWorkspaceRoots: readonly string[]
  expandedProjectWorkspaceRoots: ReadonlySet<string> | null
}) {
  if (typeof window === 'undefined') {
    return
  }

  const expandedProjectWorkspaceRoots =
    input.expandedProjectWorkspaceRoots ??
    new Set(input.currentProjectWorkspaceRoots)

  try {
    window.localStorage.setItem(
      PROJECT_EXPANSION_STORAGE_KEY,
      JSON.stringify({
        expandedProjectWorkspaceRoots:
          input.currentProjectWorkspaceRoots.flatMap((projectWorkspaceRoot) =>
            expandedProjectWorkspaceRoots.has(projectWorkspaceRoot)
              ? [projectWorkspaceRoot]
              : []
          ),
      } satisfies PersistedProjectExpansionState)
    )
  } catch {
    // Ignore storage write failures in private browsing / quota pressure.
  }
}

function syncExpandedProjectWorkspaceRoots(input: {
  currentProjectWorkspaceRoots: ReadonlySet<string>
  expandedProjectWorkspaceRoots: Set<string> | null
}): Set<string> {
  if (input.expandedProjectWorkspaceRoots === null) {
    return new Set(input.currentProjectWorkspaceRoots)
  }

  let changed = false
  const nextExpandedProjectWorkspaceRoots = new Set<string>()

  for (const projectWorkspaceRoot of input.expandedProjectWorkspaceRoots) {
    if (input.currentProjectWorkspaceRoots.has(projectWorkspaceRoot)) {
      nextExpandedProjectWorkspaceRoots.add(projectWorkspaceRoot)
      continue
    }

    changed = true
  }

  return changed
    ? nextExpandedProjectWorkspaceRoots
    : input.expandedProjectWorkspaceRoots
}

function toggleExpandedProjectWorkspaceRoot(input: {
  currentProjectWorkspaceRoots: readonly string[]
  expandedProjectWorkspaceRoots: Set<string> | null
  projectWorkspaceRoot: string
}): Set<string> {
  const nextExpandedProjectWorkspaceRoots = new Set(
    input.expandedProjectWorkspaceRoots ?? input.currentProjectWorkspaceRoots
  )

  if (nextExpandedProjectWorkspaceRoots.has(input.projectWorkspaceRoot)) {
    nextExpandedProjectWorkspaceRoots.delete(input.projectWorkspaceRoot)
  } else {
    nextExpandedProjectWorkspaceRoots.add(input.projectWorkspaceRoot)
  }

  return nextExpandedProjectWorkspaceRoots
}

function expandProjectWorkspaceRoot(input: {
  currentProjectWorkspaceRoots: readonly string[]
  expandedProjectWorkspaceRoots: Set<string> | null
  projectWorkspaceRoot: string
}): Set<string> {
  const nextExpandedProjectWorkspaceRoots = new Set(
    input.expandedProjectWorkspaceRoots ?? input.currentProjectWorkspaceRoots
  )

  nextExpandedProjectWorkspaceRoots.add(input.projectWorkspaceRoot)

  return nextExpandedProjectWorkspaceRoots
}

export default function AppSidebar() {
  const projectsSnapshot = useProjectsSnapshot()
  const activeWorkspaceId = useActiveWorkspaceId()
  const isProjectsSyncReady = useProjectsSyncReady()
  const projects = projectsSnapshot?.projects ?? []
  const projectWorkspaceRoots = projects.map((project) => project.workspaceRoot)
  const projectWorkspaceRootsKey = projectWorkspaceRoots.join('\0')
  const [expandedProjectWorkspaceRoots, setExpandedProjectWorkspaceRoots] =
    useState<Set<string> | null>(() =>
      readPersistedExpandedProjectWorkspaceRoots()
    )
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [isMutatingProject, setIsMutatingProject] = useState(false)
  const [isMutatingWorkspace, setIsMutatingWorkspace] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [workspaceDialogProjectId, setWorkspaceDialogProjectId] = useState<
    Project['id'] | null
  >(null)

  useEffect(() => {
    if (!isProjectsSyncReady) {
      return
    }

    const currentProjectWorkspaceRoots =
      projectWorkspaceRootsKey.length > 0
        ? projectWorkspaceRootsKey.split('\0')
        : []

    setExpandedProjectWorkspaceRoots((current) => {
      return syncExpandedProjectWorkspaceRoots({
        currentProjectWorkspaceRoots: new Set(currentProjectWorkspaceRoots),
        expandedProjectWorkspaceRoots: current,
      })
    })
  }, [isProjectsSyncReady, projectWorkspaceRootsKey])

  useEffect(() => {
    if (!isProjectsSyncReady) {
      return
    }

    const currentProjectWorkspaceRoots =
      projectWorkspaceRootsKey.length > 0
        ? projectWorkspaceRootsKey.split('\0')
        : []

    persistExpandedProjectWorkspaceRoots({
      currentProjectWorkspaceRoots,
      expandedProjectWorkspaceRoots,
    })
  }, [
    expandedProjectWorkspaceRoots,
    isProjectsSyncReady,
    projectWorkspaceRootsKey,
  ])

  const selectedWorkspaceProject = useMemo(
    () =>
      workspaceDialogProjectId
        ? (projects.find(
            (project) => project.id === workspaceDialogProjectId
          ) ?? null)
        : null,
    [projects, workspaceDialogProjectId]
  )

  function toggleProject(projectWorkspaceRoot: string) {
    setExpandedProjectWorkspaceRoots((current) => {
      return toggleExpandedProjectWorkspaceRoot({
        currentProjectWorkspaceRoots: projectWorkspaceRoots,
        expandedProjectWorkspaceRoots: current,
        projectWorkspaceRoot,
      })
    })
  }

  function closeWorkspaceDialog() {
    if (isMutatingWorkspace) {
      return
    }

    setWorkspaceDialogProjectId(null)
    setNewWorkspaceName('')
  }

  function openWorkspaceDialog(projectId: Project['id']) {
    setWorkspaceDialogProjectId(projectId)
    setNewWorkspaceName('')
  }

  async function createWorkspace(projectId: (typeof projects)[number]['id']) {
    const name = newWorkspaceName.trim()

    if (name.length === 0) {
      return
    }

    setIsMutatingWorkspace(true)

    try {
      const workspace = await getWsRpcClient().projects.createWorkspace({
        projectId,
        name,
      })
      const projectWorkspaceRoot = projects.find(
        (project) => project.id === projectId
      )?.workspaceRoot

      if (projectWorkspaceRoot) {
        setExpandedProjectWorkspaceRoots((current) => {
          return expandProjectWorkspaceRoot({
            currentProjectWorkspaceRoots: projectWorkspaceRoots,
            expandedProjectWorkspaceRoots: current,
            projectWorkspaceRoot,
          })
        })
      }

      setActiveWorkspaceId(workspace.id)
      setWorkspaceDialogProjectId(null)
      setNewWorkspaceName('')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setIsMutatingWorkspace(false)
    }
  }

  async function addProjectByPath(workspaceRoot: string) {
    const trimmedWorkspaceRoot = workspaceRoot.trim()

    if (trimmedWorkspaceRoot.length === 0) {
      return
    }

    setIsMutatingProject(true)

    try {
      await getWsRpcClient().projects.add({
        workspaceRoot: trimmedWorkspaceRoot,
      })
      setIsAddingProject(false)
      setNewProjectName('')
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setIsMutatingProject(false)
    }
  }

  async function commitNewProject() {
    const name = newProjectName.trim()

    if (name.length === 0) {
      return
    }

    await addProjectByPath(name)
  }

  async function startAddProjectFlow() {
    if (isElectron) {
      try {
        const workspaceRoot = await window.desktopBridge?.pickFolder()
        if (workspaceRoot) {
          await addProjectByPath(workspaceRoot)
          return
        }
      } catch {
        // Fall back to manual entry when the desktop bridge cannot open a picker.
      }
    }

    setIsAddingProject((current) => !current)
    setNewProjectName('')
  }

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <div className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1">
        <span className="truncate font-semibold text-foreground text-sm tracking-tight">
          {APP_NAME}
        </span>
        <span className="rounded-full bg-muted/50 px-1.5 py-0.5 font-medium text-[8px] text-muted-foreground/60 uppercase tracking-[0.18em]">
          {APP_STAGE_LABEL}
        </span>
      </div>
    </div>
  )

  return (
    <>
      {isElectron ? (
        <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
          {wordmark}
        </SidebarHeader>
      ) : (
        <SidebarHeader className="gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3">
          {wordmark}
        </SidebarHeader>
      )}

      <SidebarContent className="gap-0">
        <SidebarGroup className="px-2 py-2">
          <div className="mb-1 flex items-center justify-between pr-1.5 pl-2">
            <span className="font-medium text-[10px] text-muted-foreground/60 uppercase tracking-wider">
              Projects
            </span>
            <div className="flex items-center gap-1">
              <button
                aria-label="Sort projects"
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                type="button"
              >
                <ArrowUpDownIcon className="size-3.5" />
              </button>
              <button
                aria-label={
                  isAddingProject ? 'Cancel add project' : 'Add project'
                }
                aria-pressed={isAddingProject}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                disabled={isMutatingProject}
                onClick={() => {
                  startAddProjectFlow().catch(() => undefined)
                }}
                type="button"
              >
                <PlusIcon
                  className={cn(
                    'size-3.5 transition-transform duration-150',
                    isAddingProject ? 'rotate-45' : 'rotate-0'
                  )}
                />
              </button>
            </div>
          </div>

          {isAddingProject ? (
            <div className="mb-2 px-1">
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  className="min-w-0 flex-1 rounded-md border border-border bg-secondary px-2 py-1 font-mono text-foreground text-xs placeholder:text-muted-foreground/40 focus:border-ring focus:outline-none"
                  onChange={(event) => setNewProjectName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitNewProject().catch(() => undefined)
                    }

                    if (event.key === 'Escape') {
                      setIsAddingProject(false)
                      setNewProjectName('')
                    }
                  }}
                  placeholder="/path/to/project"
                  value={newProjectName}
                />
                <button
                  className="shrink-0 rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs transition-colors duration-150 hover:bg-primary/90 disabled:opacity-60"
                  disabled={
                    isMutatingProject || newProjectName.trim().length === 0
                  }
                  onClick={() => {
                    commitNewProject().catch(() => undefined)
                  }}
                  type="button"
                >
                  {isMutatingProject ? 'Adding...' : 'Add'}
                </button>
              </div>
            </div>
          ) : null}

          <SidebarMenu>
            {projects.map((project) => {
              const isExpanded =
                expandedProjectWorkspaceRoots?.has(project.workspaceRoot) ??
                true

              return (
                <SidebarMenuItem className="rounded-md" key={project.id}>
                  <div className="group/project-header relative">
                    <button
                      className="peer/menu-button flex h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
                      onClick={() => toggleProject(project.workspaceRoot)}
                      type="button"
                    >
                      <ChevronRightIcon
                        className={cn(
                          '-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150',
                          isExpanded ? 'rotate-90' : ''
                        )}
                      />
                      <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate font-medium text-foreground/90 text-xs">
                        {project.name}
                      </span>
                    </button>

                    <SidebarMenuAction
                      aria-label={`Create new workspace in ${project.name}`}
                      className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                      data-project-id={project.id}
                      data-testid="project-create-workspace"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        openWorkspaceDialog(project.id)
                      }}
                      showOnHover
                    >
                      <SquarePenIcon className="size-3.5" />
                    </SidebarMenuAction>
                  </div>

                  {isExpanded ? (
                    <ul className="mx-1 my-0 flex w-full min-w-0 translate-x-0 flex-col gap-0.5 overflow-hidden border-sidebar-border border-l px-1.5 py-0">
                      {project.workspaces.length === 0 ? (
                        <li className="w-full">
                          <div className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60">
                            <span>No workspaces yet</span>
                          </div>
                        </li>
                      ) : null}

                      {project.workspaces.map((workspace) => {
                        const isActive = activeWorkspaceId === workspace.id
                        const isSelected = false
                        const isHighlighted = isActive || isSelected

                        return (
                          <li
                            className="group/menu-sub-item relative w-full"
                            key={workspace.id}
                          >
                            <SidebarMenuSubButton
                              className={`${resolveWorkspaceRowClassName({
                                isActive,
                                isSelected,
                              })} relative isolate`}
                              data-testid="workspace-row"
                              data-workspace-id={workspace.id}
                              isActive={isActive}
                              onClick={() => setActiveWorkspaceId(workspace.id)}
                              render={<button type="button" />}
                              size="sm"
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                <span className="min-w-0 flex-1 truncate text-xs">
                                  {workspace.name}
                                </span>
                              </div>
                              <div className="ml-auto flex min-w-12 justify-end">
                                <span
                                  className={cn(
                                    'text-[10px]',
                                    isHighlighted
                                      ? 'text-foreground/72 dark:text-foreground/82'
                                      : 'text-muted-foreground/40'
                                  )}
                                >
                                  {formatUpdatedLabel(workspace.updatedAt)}
                                </span>
                              </div>
                            </SidebarMenuSubButton>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </SidebarMenuItem>
              )
            })}

            {projectsSnapshot === null ? (
              <SidebarMenuItem>
                <div className="flex h-7 items-center rounded-md px-2 text-muted-foreground/60 text-xs">
                  Connecting...
                </div>
              </SidebarMenuItem>
            ) : null}

            {projectsSnapshot !== null && projects.length === 0 ? (
              <SidebarMenuItem>
                <div className="flex h-7 items-center rounded-md px-2 text-muted-foreground/60 text-xs">
                  No projects yet
                </div>
              </SidebarMenuItem>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator className="mx-0 w-full" />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <button
              className="flex h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-muted-foreground/70 text-xs hover:bg-accent hover:text-foreground"
              type="button"
            >
              <SettingsIcon className="size-3.5" />
              <span className="text-xs">Settings</span>
            </button>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeWorkspaceDialog()
          }
        }}
        open={workspaceDialogProjectId !== null}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create workspace</DialogTitle>
            <DialogDescription>
              {selectedWorkspaceProject
                ? `Create a new git worktree for ${selectedWorkspaceProject.name}.`
                : 'Create a new git worktree.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label
              className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.16em]"
              htmlFor="workspace-name"
            >
              Workspace name
            </label>
            <Input
              autoFocus
              disabled={isMutatingWorkspace}
              id="workspace-name"
              onChange={(event) => {
                setNewWorkspaceName(
                  normalizeWorkspaceNameInput(event.target.value)
                )
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  workspaceDialogProjectId &&
                  !isMutatingWorkspace
                ) {
                  createWorkspace(workspaceDialogProjectId).catch(
                    () => undefined
                  )
                }

                if (event.key === 'Escape') {
                  closeWorkspaceDialog()
                }
              }}
              placeholder="laborer/my-feature"
              value={newWorkspaceName}
            />
          </div>

          <DialogFooter>
            <Button onClick={closeWorkspaceDialog} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={
                isMutatingWorkspace ||
                workspaceDialogProjectId === null ||
                newWorkspaceName.trim().length === 0
              }
              onClick={() => {
                if (workspaceDialogProjectId) {
                  createWorkspace(workspaceDialogProjectId).catch(
                    () => undefined
                  )
                }
              }}
            >
              {isMutatingWorkspace ? 'Creating...' : 'Create workspace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
