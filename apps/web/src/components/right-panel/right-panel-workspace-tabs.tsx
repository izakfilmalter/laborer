/**
 * The right panel's workspace tab strip.
 *
 * The panel is one sidebar per window, so it has to say whose surfaces it is
 * showing. This strip is that answer: every open workspace in the window tab,
 * filed under its project, in one horizontally scrollable row above the
 * surface strip. It renders even with a single workspace open — the strip is
 * the panel's identity, not an overflow affordance.
 *
 * Picking a tab repoints the panel only. Pane focus stays where it is, which
 * is what lets someone read one workspace's diff while typing in another.
 */

import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { cn } from '@laborer/ui/lib/utils'
import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useRef,
} from 'react'
import { ProjectIcon } from '@/components/project-icon'
import type { RightPanelProjectGroup } from './right-panel-workspace-groups'

/** The workspace-tab badge: how many surfaces that workspace holds. */
function SurfaceCountBadge({ count }: { readonly count: number }) {
  if (count <= 0) {
    return null
  }
  return (
    <span
      className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 font-semibold text-[9px] text-primary-foreground tabular-nums"
      data-surface-count-badge
    >
      {count}
    </span>
  )
}

/** Roving selection: arrows step one tab, wrapping across projects. */
const ARROW_OFFSETS: Readonly<Record<string, number>> = {
  ArrowLeft: -1,
  ArrowRight: 1,
}

const TAB_CLASS =
  'flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs'
const ACTIVE_TAB_CLASS = 'bg-accent text-foreground'
const IDLE_TAB_CLASS =
  'text-muted-foreground hover:bg-accent/60 hover:text-foreground'

export function RightPanelWorkspaceTabs({
  groups,
  onSelectWorkspace,
  selectedWorkspaceId,
  surfaceCounts,
}: {
  /** Ordered projects, each with its open workspaces in layout order. */
  readonly groups: readonly RightPanelProjectGroup[]
  readonly onSelectWorkspace: (workspaceId: string) => void
  readonly selectedWorkspaceId: string | null
  /** Surface count per workspace id; missing means none. */
  readonly surfaceCounts: Readonly<Record<string, number>>
}) {
  const tabListRef = useRef<HTMLDivElement | null>(null)

  // Keep the selected tab in view as selection moves — following pane focus
  // can select a workspace whose tab is scrolled out of the strip.
  useEffect(() => {
    if (selectedWorkspaceId === null) {
      return
    }
    const activeTab = tabListRef.current?.querySelector<HTMLElement>(
      "[data-active-tab='true']"
    )
    // jsdom does not implement scrollIntoView; guard for tests.
    if (typeof activeTab?.scrollIntoView === 'function') {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [selectedWorkspaceId])

  const workspaceIds = groups.flatMap((group) =>
    group.workspaces.map((workspace) => workspace.id)
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const offset = ARROW_OFFSETS[event.key] ?? 0
    const current = selectedWorkspaceId
      ? workspaceIds.indexOf(selectedWorkspaceId)
      : -1
    let nextIndex: number | null = null
    if (offset !== 0) {
      nextIndex =
        current === -1
          ? 0
          : (current + offset + workspaceIds.length) % workspaceIds.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = workspaceIds.length - 1
    }
    const nextId = nextIndex === null ? undefined : workspaceIds[nextIndex]
    if (nextId === undefined) {
      return
    }
    event.preventDefault()
    onSelectWorkspace(nextId)
  }

  if (groups.length === 0) {
    return null
  }

  return (
    <div
      className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b bg-muted/30 pr-3 pl-2"
      data-right-panel-workspace-tabbar
    >
      <ScrollArea
        className="min-w-0 flex-1 rounded-none"
        data-right-panel-workspace-tab-list
        fill
        scrollFade
      >
        <div
          aria-label="Open workspaces"
          className="flex h-full w-max min-w-full items-center gap-1"
          onKeyDown={handleKeyDown}
          ref={tabListRef}
          role="tablist"
        >
          {groups.map((group, groupIndex) => {
            const firstWorkspaceId = group.workspaces[0]?.id
            return (
              <Fragment key={group.project.id}>
                {groupIndex > 0 ? (
                  <span
                    aria-hidden
                    className="mx-1 h-3.5 w-px shrink-0 bg-border"
                    data-workspace-tab-divider
                  />
                ) : null}
                <button
                  className={cn(TAB_CLASS, 'font-medium', IDLE_TAB_CLASS)}
                  onClick={() => {
                    if (firstWorkspaceId !== undefined) {
                      onSelectWorkspace(firstWorkspaceId)
                    }
                  }}
                  title={group.project.name}
                  type="button"
                >
                  <ProjectIcon project={group.project} />
                  <span className="max-w-32 truncate">
                    {group.project.name}
                  </span>
                </button>
                {group.workspaces.map((workspace) => {
                  const active = workspace.id === selectedWorkspaceId
                  return (
                    <button
                      aria-selected={active}
                      className={cn(
                        TAB_CLASS,
                        active ? ACTIVE_TAB_CLASS : IDLE_TAB_CLASS
                      )}
                      data-active-tab={active}
                      key={workspace.id}
                      onClick={() => onSelectWorkspace(workspace.id)}
                      role="tab"
                      tabIndex={active ? 0 : -1}
                      title={
                        workspace.worktreePath.length > 0
                          ? workspace.worktreePath
                          : workspace.branchName
                      }
                      type="button"
                    >
                      <span className="max-w-32 truncate">
                        {workspace.branchName}
                      </span>
                      <SurfaceCountBadge
                        count={surfaceCounts[workspace.id] ?? 0}
                      />
                    </button>
                  )
                })}
              </Fragment>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
