/**
 * Command palette (⌘K), ported from t3code's palette surface.
 *
 * Groups are plain objects built per render from app context; filtering and
 * ranking live in `command-palette.logic.ts`. Submenus are a view stack —
 * Backspace on an empty query (or the back arrow) pops a level.
 */

import type { SharedProjectRow } from '@laborer/shared/rpc'
import { useHotkeySequence } from '@tanstack/react-hotkeys'
import {
  ArrowDownToLineIcon,
  ArrowLeftIcon,
  ArrowUpFromLineIcon,
  FolderGit2Icon,
  GitBranchIcon,
  KanbanIcon,
  MaximizeIcon,
  MonitorIcon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  SettingsIcon,
  SlackIcon,
  SquarePlusIcon,
  SunIcon,
  SunMoonIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import {
  type KeyboardEvent,
  useCallback,
  useDeferredValue,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useAppSettings } from '@/components/app-settings-context'
import type { WorkspaceView } from '@/db/shared-state'
import {
  createWorkspaceIntent,
  isSlackUrlInput,
  toBranchName,
  useCreateWorkspace,
} from '@/hooks/use-create-workspace'
import { useWorkspaceSyncActions } from '@/hooks/use-workspace-sync-actions'
import { extractErrorMessage } from '@/lib/errors'
import { KEYBINDS } from '@/lib/keybinds'
import { toast } from '@/lib/toast'
import { findWorkspaceCommandPaletteContainer } from '@/lib/workspace-elements'
import { useActiveWorkspaceId, usePanelActions } from '@/panels/panel-context'
import { CommandDialog, CommandDialogPopup } from './command'
import {
  ACTIONS_GROUP_VALUE,
  buildCreateWorkspaceGroup,
  type CommandPaletteActionItem,
  type CommandPaletteEntry,
  type CommandPaletteGroup,
  type CommandPaletteView,
  filterCommandPaletteGroups,
} from './command-palette.logic'
import { CommandPaletteContent } from './command-palette-content'
import { CommandPaletteResults } from './command-palette-results'

const ITEM_ICON_CLASS = 'size-4 shrink-0 text-muted-foreground'

/** Workspaces shown at root before the user starts searching. */
const WORKSPACE_LIMIT = 9

interface CommandPaletteProps {
  readonly onToggleBoard: () => void
  readonly onToggleSidebar?: (() => void) | undefined
  readonly projects: readonly SharedProjectRow[]
  readonly workspaces: readonly WorkspaceView[]
}

interface CommandPaletteScope {
  readonly container: HTMLElement | null
  readonly workspaceId: string | null
}

export function CommandPalette(props: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<CommandPaletteScope | null>(null)
  const activeWorkspaceId = useActiveWorkspaceId()
  const workspaceContainer = scope?.container ?? null

  useHotkeySequence(['Meta+K'], (event) => {
    event.preventDefault()
    if (open) {
      setOpen(false)
      return
    }

    const container = activeWorkspaceId
      ? findWorkspaceCommandPaletteContainer(activeWorkspaceId)
      : null
    setScope({
      container,
      workspaceId: container?.dataset.workspaceId ?? activeWorkspaceId,
    })
    setOpen(true)
  })

  return (
    <CommandDialog onOpenChange={setOpen} open={open}>
      <CommandDialogPopup
        aria-label="Command palette"
        data-testid="command-palette"
        onBackdropPointerDown={() => setOpen(false)}
        portalContainer={workspaceContainer}
      >
        {open && (
          <OpenCommandPalette
            activeWorkspaceId={scope?.workspaceId ?? activeWorkspaceId}
            setOpen={setOpen}
            {...props}
          />
        )}
      </CommandDialogPopup>
    </CommandDialog>
  )
}

function OpenCommandPalette(
  props: CommandPaletteProps & {
    readonly activeWorkspaceId: string | null
    readonly setOpen: (open: boolean) => void
  }
) {
  const { activeWorkspaceId, setOpen } = props
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [highlightedItemValue, setHighlightedItemValue] = useState<
    string | null
  >(null)
  const [viewStack, setViewStack] = useState<readonly CommandPaletteView[]>([])
  const currentView = viewStack.at(-1) ?? null

  const panelActions = usePanelActions()
  const appSettings = useAppSettings()
  const { setTheme } = useTheme()
  const createWorkspace = useCreateWorkspace()
  const { pushWorkspace, pullWorkspace } = useWorkspaceSyncActions()

  const projectNameById = useMemo(
    () => new Map(props.projects.map((project) => [project.id, project.name])),
    [props.projects]
  )

  /**
   * Enter the free-text step for one project: the input stops filtering and
   * becomes the branch-name-or-Slack-link field, exactly like the sidebar
   * and kanban composers.
   */
  const pushCreateWorkspaceView = useCallback(
    (project: { readonly id: string; readonly name: string }) => {
      setViewStack((views) => [
        ...views,
        {
          kind: 'create-workspace',
          projectId: project.id,
          projectName: project.name,
        },
      ])
      setHighlightedItemValue(null)
      setQuery('')
    },
    []
  )

  /**
   * Commit a workspace creation. Mirrors the inline composers' confirmation
   * copy; the palette closes, so late failures land as toasts.
   */
  const runCreateWorkspace = useCallback(
    async (projectId: string, trimmed: string) => {
      const intent = createWorkspaceIntent(trimmed)
      await createWorkspace({ branchNameOrSlackUrl: trimmed, projectId })
      toast.success(
        intent === 'slack'
          ? 'Slack link added — reading the thread in the background.'
          : `Creating ${trimmed === '' ? 'an auto-named workspace' : `"${trimmed}"`}…`
      )
    },
    [createWorkspace]
  )

  const rootGroups = useMemo((): readonly CommandPaletteGroup[] => {
    const activeWorkspace = props.workspaces.find(
      (workspace) =>
        workspace.id === activeWorkspaceId && workspace.status !== 'destroyed'
    )
    const activeProject = activeWorkspace
      ? props.projects.find(
          (project) => project.id === activeWorkspace.projectId
        )
      : undefined

    const newWorkspaceItems: CommandPaletteActionItem[] = props.projects.map(
      (project) => ({
        icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
        keepOpen: true,
        kind: 'action',
        run: () => {
          pushCreateWorkspaceView(project)
        },
        searchTerms: [project.name, project.rootPath],
        title: project.name,
        description: project.rootPath,
        value: `new-workspace:${project.id}`,
      })
    )

    const actionItems: CommandPaletteEntry[] = [
      ...(activeProject
        ? [
            {
              description: activeProject.rootPath,
              icon: <FolderGit2Icon className={ITEM_ICON_CLASS} />,
              keepOpen: true,
              kind: 'action',
              run: () => {
                pushCreateWorkspaceView(activeProject)
              },
              searchTerms: [
                'new workspace',
                'create workspace',
                activeProject.name,
                activeProject.rootPath,
              ],
              title: `New workspace in ${activeProject.name}`,
              value: `action:new-workspace-in-active-project:${activeProject.id}`,
            } satisfies CommandPaletteActionItem,
          ]
        : []),
      {
        icon: <KanbanIcon className={ITEM_ICON_CLASS} />,
        kind: 'action',
        run: props.onToggleBoard,
        searchTerms: ['toggle task board', 'kanban'],
        shortcut: KEYBINDS.TOGGLE_BOARD,
        title: 'Toggle task board',
        value: 'action:toggle-board',
      },
      {
        groups: [
          {
            items: newWorkspaceItems,
            label: 'Projects',
            value: 'new-workspace-projects',
          },
        ],
        icon: <PlusIcon className={ITEM_ICON_CLASS} />,
        kind: 'submenu',
        searchTerms: ['new workspace in', 'create workspace', 'branch'],
        title: 'New workspace in...',
        value: 'action:new-workspace-in',
      },
      {
        disabled: activeWorkspaceId === null,
        icon: <ArrowUpFromLineIcon className={ITEM_ICON_CLASS} />,
        kind: 'action',
        run: async () => {
          if (activeWorkspaceId) {
            await pushWorkspace(activeWorkspaceId)
          }
        },
        searchTerms: ['push workspace', 'git push'],
        shortcut: KEYBINDS.PUSH_WORKSPACE,
        title: 'Push workspace',
        value: 'action:push-workspace',
      },
      {
        disabled: activeWorkspaceId === null,
        icon: <ArrowDownToLineIcon className={ITEM_ICON_CLASS} />,
        kind: 'action',
        run: async () => {
          if (activeWorkspaceId) {
            await pullWorkspace(activeWorkspaceId)
          }
        },
        searchTerms: ['pull workspace', 'git pull'],
        shortcut: KEYBINDS.PULL_WORKSPACE,
        title: 'Pull workspace',
        value: 'action:pull-workspace',
      },
      {
        disabled: panelActions?.addWindowTab === undefined,
        icon: <SquarePlusIcon className={ITEM_ICON_CLASS} />,
        kind: 'action',
        run: () => {
          panelActions?.addWindowTab?.()
        },
        searchTerms: ['new window tab'],
        shortcut: KEYBINDS.NEW_WINDOW_TAB,
        title: 'New window tab',
        value: 'action:new-window-tab',
      },
      {
        disabled: panelActions === null,
        icon: <MaximizeIcon className={ITEM_ICON_CLASS} />,
        kind: 'action',
        run: () => {
          panelActions?.toggleFullscreenPane()
        },
        searchTerms: ['toggle fullscreen pane', 'zoom'],
        shortcut: KEYBINDS.TOGGLE_FULLSCREEN,
        title: 'Toggle fullscreen pane',
        value: 'action:toggle-fullscreen',
      },
      ...(props.onToggleSidebar
        ? [
            {
              icon: <PanelLeftIcon className={ITEM_ICON_CLASS} />,
              kind: 'action',
              run: props.onToggleSidebar,
              searchTerms: ['toggle sidebar'],
              title: 'Toggle sidebar',
              value: 'action:toggle-sidebar',
            } satisfies CommandPaletteActionItem,
          ]
        : []),
      {
        groups: [
          {
            items: [
              {
                icon: <SunIcon className={ITEM_ICON_CLASS} />,
                kind: 'action',
                run: () => setTheme('light'),
                searchTerms: ['light theme'],
                title: 'Light',
                value: 'theme:light',
              },
              {
                icon: <MoonIcon className={ITEM_ICON_CLASS} />,
                kind: 'action',
                run: () => setTheme('dark'),
                searchTerms: ['dark theme'],
                title: 'Dark',
                value: 'theme:dark',
              },
              {
                icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
                kind: 'action',
                run: () => setTheme('system'),
                searchTerms: ['system theme'],
                title: 'System',
                value: 'theme:system',
              },
            ],
            label: 'Theme',
            value: 'themes',
          },
        ],
        icon: <SunMoonIcon className={ITEM_ICON_CLASS} />,
        kind: 'submenu',
        searchTerms: ['change theme', 'dark mode', 'light mode', 'appearance'],
        title: 'Change theme...',
        value: 'action:change-theme',
      },
      {
        icon: <SettingsIcon className={ITEM_ICON_CLASS} />,
        kind: 'action',
        run: () => appSettings.onOpenChange(true),
        searchTerms: ['open settings', 'preferences'],
        title: 'Open settings',
        value: 'action:open-settings',
      },
    ]

    const isSearching = deferredQuery.trim().length > 0
    const visibleWorkspaces = props.workspaces.filter(
      (workspace) => workspace.status !== 'destroyed'
    )
    const workspaceItems: CommandPaletteActionItem[] = (
      isSearching
        ? visibleWorkspaces
        : visibleWorkspaces.slice(0, WORKSPACE_LIMIT)
    ).map((workspace) => {
      const projectName = projectNameById.get(workspace.projectId)
      return {
        description: [projectName, workspace.prTitle]
          .filter((part): part is string => Boolean(part))
          .join(' · '),
        icon: <GitBranchIcon className={ITEM_ICON_CLASS} />,
        kind: 'action',
        run: () => {
          panelActions?.focusWorkspace(workspace.id)
        },
        searchTerms: [
          workspace.branchName,
          projectName ?? '',
          workspace.prTitle ?? '',
        ],
        title: workspace.branchName,
        value: `workspace:${workspace.id}`,
      }
    })

    const groups: CommandPaletteGroup[] = [
      { items: actionItems, label: 'Actions', value: ACTIONS_GROUP_VALUE },
    ]
    if (workspaceItems.length > 0) {
      groups.push({
        items: workspaceItems,
        label: 'Workspaces',
        value: 'workspaces',
      })
    }
    return groups
  }, [
    activeWorkspaceId,
    appSettings,
    deferredQuery,
    panelActions,
    projectNameById,
    props.onToggleBoard,
    props.onToggleSidebar,
    props.projects,
    props.workspaces,
    pullWorkspace,
    pushCreateWorkspaceView,
    pushWorkspace,
    setTheme,
  ])

  const displayedGroups = useMemo(() => {
    if (currentView?.kind === 'create-workspace') {
      const trimmed = query.trim()
      const intent = createWorkspaceIntent(trimmed)
      return buildCreateWorkspaceGroup({
        branchName: toBranchName(trimmed),
        icon:
          intent === 'slack' || intent === 'unrecognized-link' ? (
            <SlackIcon className={ITEM_ICON_CLASS} />
          ) : (
            <GitBranchIcon className={ITEM_ICON_CLASS} />
          ),
        intent,
        projectName: currentView.projectName,
        query: trimmed,
        run: () => runCreateWorkspace(currentView.projectId, trimmed),
      })
    }
    return filterCommandPaletteGroups({
      groups: currentView?.groups ?? rootGroups,
      query: deferredQuery,
    })
  }, [currentView, deferredQuery, query, rootGroups, runCreateWorkspace])

  const popView = useCallback(() => {
    setViewStack((views) => views.slice(0, -1))
    setHighlightedItemValue(null)
    setQuery('')
  }, [])

  const executeItem = useCallback(
    (item: CommandPaletteEntry) => {
      if (item.disabled) {
        return
      }

      if (item.kind === 'submenu') {
        setViewStack((views) => [
          ...views,
          { groups: item.groups, kind: 'items', title: item.title },
        ])
        setHighlightedItemValue(null)
        setQuery('')
        return
      }

      if (!item.keepOpen) {
        setOpen(false)
      }

      Promise.resolve(item.run()).catch((error: unknown) => {
        toast.error(`Unable to run command: ${extractErrorMessage(error)}`)
      })
    },
    [setOpen]
  )

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      // The Autocomplete input consumes Escape for its own (always-open)
      // list, so the dialog never hears it. Close the palette ourselves.
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        return
      }

      if (event.key === 'Backspace' && query === '' && currentView !== null) {
        event.preventDefault()
        popView()
      }
    },
    [currentView, popView, query, setOpen]
  )

  // Pasting a Slack message link commits immediately, matching the sidebar
  // and kanban composers' `commitsOnPaste` behavior.
  const wasPasteRef = useRef(false)

  const handleQueryChange = useCallback(
    (nextQuery: string) => {
      const wasPaste = wasPasteRef.current
      wasPasteRef.current = false
      setHighlightedItemValue(null)

      if (currentView?.kind !== 'create-workspace') {
        setQuery(nextQuery)
        return
      }

      // Mask typed text into a branch name unless it is (becoming) a URL,
      // like the composers' IMask `prepare` step.
      const masked = isSlackUrlInput(nextQuery)
        ? nextQuery
        : toBranchName(nextQuery)
      setQuery(masked)

      if (wasPaste && createWorkspaceIntent(masked.trim()) === 'slack') {
        setOpen(false)
        runCreateWorkspace(currentView.projectId, masked.trim()).catch(
          (error: unknown) => {
            toast.error(
              `Unable to create workspace: ${extractErrorMessage(error)}`
            )
          }
        )
      }
    },
    [currentView, runCreateWorkspace, setOpen]
  )

  const placeholder = (() => {
    if (currentView?.kind === 'create-workspace') {
      return `${currentView.projectName}/my-feature, or paste a Slack link`
    }
    return currentView ? 'Search...' : 'Search commands and workspaces...'
  })()

  return (
    <CommandPaletteContent
      inputProps={{
        'aria-label':
          currentView?.kind === 'create-workspace'
            ? `Branch name or Slack URL for ${currentView.projectName}`
            : undefined,
        onKeyDown: handleInputKeyDown,
        onPaste: () => {
          wasPasteRef.current = true
        },
        placeholder,
        ...(currentView
          ? {
              startAddon: (
                <button
                  aria-label="Back"
                  className="flex cursor-pointer items-center text-muted-foreground"
                  onClick={popView}
                  type="button"
                >
                  <ArrowLeftIcon />
                </button>
              ),
            }
          : {}),
      }}
      key={viewStack.length}
      mode="none"
      onItemHighlighted={(value) => {
        setHighlightedItemValue(typeof value === 'string' ? value : null)
      }}
      onValueChange={handleQueryChange}
      showBackHint={currentView !== null}
      value={query}
    >
      <CommandPaletteResults
        groups={displayedGroups}
        highlightedItemValue={highlightedItemValue}
        onExecuteItem={executeItem}
      />
    </CommandPaletteContent>
  )
}
