import {
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderIcon,
  PlusIcon,
  SettingsIcon,
  SquarePenIcon,
} from 'lucide-react'
import { useState } from 'react'

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
import { cn } from '@/lib/utils'

const APP_STAGE_LABEL = 'Alpha'

interface ShellThread {
  id: string
  title: string
  updatedLabel: string
}

interface ShellProject {
  id: string
  name: string
  threads: ShellThread[]
}

const INITIAL_PROJECTS: ShellProject[] = [
  {
    id: 'project-laborer',
    name: 'laborer',
    threads: [
      {
        id: 'thread-new',
        title: 'New thread',
        updatedLabel: '35d ago',
      },
    ],
  },
]

function createShellId(prefix: string) {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `${prefix}-${crypto.randomUUID()}`
  }

  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function resolveThreadRowClassName(input: {
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

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0 text-foreground"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  )
}

export default function AppSidebar() {
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(INITIAL_PROJECTS.map((project) => project.id))
  )
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [projects, setProjects] = useState(INITIAL_PROJECTS)

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current)

      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }

      return next
    })
  }

  function addThread(projectId: string) {
    const threadId = createShellId('thread')

    setProjects((current) =>
      current.map((project) => {
        if (project.id !== projectId) {
          return project
        }

        return {
          ...project,
          threads: [
            {
              id: threadId,
              title: 'New thread',
              updatedLabel: 'just now',
            },
            ...project.threads,
          ],
        }
      })
    )

    setExpandedProjectIds((current) => new Set(current).add(projectId))
    setActiveThreadId(threadId)
  }

  function commitNewProject() {
    const name = newProjectName.trim()

    if (name.length === 0) {
      return
    }

    const projectId = createShellId('project')

    setProjects((current) => [
      {
        id: projectId,
        name,
        threads: [],
      },
      ...current,
    ])
    setExpandedProjectIds((current) => new Set(current).add(projectId))
    setIsAddingProject(false)
    setNewProjectName('')
  }

  const wordmark = (
    <div className="flex items-center gap-2">
      <SidebarTrigger className="shrink-0 md:hidden" />
      <div className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1">
        <T3Wordmark />
        <span className="truncate font-medium text-muted-foreground text-sm tracking-tight">
          Code
        </span>
        <span className="rounded-full bg-muted/50 px-1.5 py-0.5 font-medium text-[8px] text-muted-foreground/60 uppercase tracking-[0.18em]">
          {APP_STAGE_LABEL}
        </span>
      </div>
    </div>
  )

  return (
    <>
      <SidebarHeader className="drag-region h-[52px] flex-row items-center gap-2 px-4 py-0 pl-[90px]">
        {wordmark}
      </SidebarHeader>

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
                onClick={() => {
                  setIsAddingProject((current) => !current)
                  setNewProjectName('')
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
                      commitNewProject()
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
                  disabled={newProjectName.trim().length === 0}
                  onClick={commitNewProject}
                  type="button"
                >
                  Add
                </button>
              </div>
            </div>
          ) : null}

          <SidebarMenu>
            {projects.map((project) => {
              const isExpanded = expandedProjectIds.has(project.id)

              return (
                <SidebarMenuItem className="rounded-md" key={project.id}>
                  <div className="group/project-header relative">
                    <button
                      className="peer/menu-button flex h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground"
                      onClick={() => toggleProject(project.id)}
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
                      aria-label={`Create new thread in ${project.name}`}
                      className="top-1 right-1.5 size-5 rounded-md p-0 text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        addThread(project.id)
                      }}
                      showOnHover
                    >
                      <SquarePenIcon className="size-3.5" />
                    </SidebarMenuAction>
                  </div>

                  {isExpanded ? (
                    <ul className="mx-1 my-0 flex w-full min-w-0 translate-x-0 flex-col gap-0.5 overflow-hidden border-sidebar-border border-l px-1.5 py-0">
                      {project.threads.length === 0 ? (
                        <li className="w-full">
                          <div className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60">
                            <span>No threads yet</span>
                          </div>
                        </li>
                      ) : null}

                      {project.threads.map((thread) => {
                        const isActive = activeThreadId === thread.id
                        const isSelected = false
                        const isHighlighted = isActive || isSelected

                        return (
                          <li
                            className="group/menu-sub-item relative w-full"
                            key={thread.id}
                          >
                            <SidebarMenuSubButton
                              className={`${resolveThreadRowClassName({
                                isActive,
                                isSelected,
                              })} relative isolate`}
                              isActive={isActive}
                              onClick={() => setActiveThreadId(thread.id)}
                              render={<button type="button" />}
                              size="sm"
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                                <span className="min-w-0 flex-1 truncate text-xs">
                                  {thread.title}
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
                                  {thread.updatedLabel}
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
    </>
  )
}
