import type { WindowLayout } from '@laborer/shared/types'
import {
  Columns3,
  PanelLeftClose,
  PanelLeftOpen,
  SquareKanban,
} from 'lucide-react'
import { useCallback, useMemo } from 'react'
import { CloseWindowTabShortcutHint } from '@/components/close-shortcut-hint'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import type { TabBarItem } from '@/components/ui/tab-bar'
import { TabBar } from '@/components/ui/tab-bar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface WindowTabBarProps {
  readonly onCloseTab: (() => void) | undefined
  readonly onNewTab: (() => void) | undefined
  readonly onRenameTab: ((tabId: string, label: string) => void) | undefined
  readonly onReorderTabs:
    | ((fromIndex: number, toIndex: number) => void)
    | undefined
  readonly onSelectTab: ((tabId: string) => void) | undefined
  readonly windowLayout: WindowLayout | undefined
}

/**
 * Renders the window-level tab bar using the shared TabBar component.
 * Auto-hides when there is only 1 tab.
 */
function WindowTabBar({
  windowLayout,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onRenameTab,
  onReorderTabs,
}: WindowTabBarProps) {
  const items: readonly TabBarItem[] = useMemo(() => {
    if (!windowLayout) {
      return []
    }
    return windowLayout.tabs.map((tab, index) => {
      let shortcutHint: React.ReactNode
      if (index < 8) {
        shortcutHint = (
          <>
            <Kbd>Cmd</Kbd>
            <Kbd>{index + 1}</Kbd>
          </>
        )
      } else if (index === windowLayout.tabs.length - 1) {
        shortcutHint = (
          <>
            <Kbd>Cmd</Kbd>
            <Kbd>9</Kbd>
          </>
        )
      }

      return {
        id: tab.id,
        label: tab.label ?? `Tab ${index + 1}`,
        isActive: tab.id === windowLayout.activeTabId,
        shortcutHint,
      }
    })
  }, [windowLayout])

  const handleClose = useCallback(() => {
    onCloseTab?.()
  }, [onCloseTab])

  const handleNew = useCallback(() => {
    onNewTab?.()
  }, [onNewTab])

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      onReorderTabs?.(fromIndex, toIndex)
    },
    [onReorderTabs]
  )

  const handleSelect = useCallback(
    (tabId: string) => {
      onSelectTab?.(tabId)
    },
    [onSelectTab]
  )

  const handleRename = useCallback(
    (tabId: string, label: string) => {
      onRenameTab?.(tabId, label)
    },
    [onRenameTab]
  )

  if (items.length === 0) {
    return null
  }

  return (
    <TabBar
      className="border-b-0"
      closeTooltip={
        <>
          Close tab <CloseWindowTabShortcutHint />
        </>
      }
      items={items}
      label="Window Tabs"
      newTabTooltip={
        <>
          New window tab <Kbd>Cmd</Kbd>
          <Kbd>T</Kbd>
        </>
      }
      onClose={handleClose}
      onNew={handleNew}
      onRename={handleRename}
      onReorder={handleReorder}
      onSelect={handleSelect}
    />
  )
}

/**
 * Bar rendered at the top of the main content area (right of the sidebar).
 *
 * Shows the sidebar toggle, the board overlay toggle, and the
 * window-level tab bar (auto-hidden when 1 tab).
 *
 * @see Issue #8: Window tab bar integration
 */
export function PanelHeaderBar({
  boardOpen,
  onCleanUpLayout,
  onToggleBoard,
  onToggleSidebar,
  sidebarCollapsed,
  windowLayout,
  onSelectWindowTab,
  onCloseWindowTab,
  onNewWindowTab,
  onRenameWindowTab,
  onReorderWindowTabs,
}: {
  readonly boardOpen: boolean
  readonly onCleanUpLayout?: (() => void) | undefined
  readonly onToggleBoard: () => void
  readonly onToggleSidebar?: (() => void) | undefined
  readonly sidebarCollapsed?: boolean
  readonly windowLayout?: WindowLayout | undefined
  readonly onSelectWindowTab?: ((tabId: string) => void) | undefined
  readonly onCloseWindowTab?: (() => void) | undefined
  readonly onNewWindowTab?: (() => void) | undefined
  readonly onRenameWindowTab?:
    | ((tabId: string, label: string) => void)
    | undefined
  readonly onReorderWindowTabs?:
    | ((fromIndex: number, toIndex: number) => void)
    | undefined
}) {
  return (
    <div className="drag-region flex h-10 shrink-0 items-center border-b px-2">
      {/* Left: sidebar toggle + view toggle + view label */}
      <div className="flex shrink-0 items-center gap-2">
        {onToggleSidebar && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={
                    sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
                  }
                  onClick={onToggleSidebar}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen className="size-3.5" />
              ) : (
                <PanelLeftClose className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipContent>
              {sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={boardOpen ? 'Close board' : 'Open board'}
                aria-pressed={boardOpen}
                className={boardOpen ? 'bg-accent' : ''}
                onClick={onToggleBoard}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <SquareKanban className="size-3.5" />
          </TooltipTrigger>
          <TooltipContent>
            {boardOpen ? 'Close board' : 'Open board'} <Kbd>Cmd</Kbd>
            <Kbd>K</Kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Window tab bar (auto-hides with 1 tab) */}
      <WindowTabBar
        onCloseTab={onCloseWindowTab}
        onNewTab={onNewWindowTab}
        onRenameTab={onRenameWindowTab}
        onReorderTabs={onReorderWindowTabs}
        onSelectTab={onSelectWindowTab}
        windowLayout={windowLayout}
      />

      {/* Right: layout actions */}
      {onCleanUpLayout && (
        <div className="ml-auto flex shrink-0 items-center gap-2 pl-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Clean up layout"
                  onClick={onCleanUpLayout}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Columns3 className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>
              Clean up layout — give every workspace room
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
