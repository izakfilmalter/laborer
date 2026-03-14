import type { WindowLayout } from '@laborer/shared/types'
import {
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Terminal,
} from 'lucide-react'
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import type { TabBarItem } from '@/components/ui/tab-bar'
import { TabBar } from '@/components/ui/tab-bar'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/** The two main content views: terminal panels, cross-project dashboard, or plan editor. */
export type MainView = 'panels' | 'dashboard' | 'plan'

/** Displays the contextual label for the current view. */
function ViewContextLabel({ mainView }: { readonly mainView: MainView }) {
  if (mainView === 'panels') {
    return <span className="text-foreground">Panels</span>
  }
  if (mainView === 'dashboard') {
    return <span className="text-foreground">Dashboard</span>
  }
  if (mainView === 'plan') {
    return <span className="text-foreground">Plan</span>
  }
  return null
}

interface WindowTabBarProps {
  readonly onCloseTab: (() => void) | undefined
  readonly onNewTab: (() => void) | undefined
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
  onReorderTabs,
}: WindowTabBarProps) {
  const items: readonly TabBarItem[] = useMemo(() => {
    if (!windowLayout) {
      return []
    }
    return windowLayout.tabs.map((tab, index) => ({
      id: tab.id,
      label: tab.label ?? `Tab ${index + 1}`,
      isActive: tab.id === windowLayout.activeTabId,
    }))
  }, [windowLayout])

  if (items.length === 0) {
    return null
  }

  return (
    <TabBar
      autoHide
      className="border-b-0"
      items={items}
      newTabTooltip="New window tab (Cmd+N)"
      onClose={onCloseTab ? () => onCloseTab() : () => undefined}
      onNew={onNewTab ?? (() => undefined)}
      onReorder={onReorderTabs ?? (() => undefined)}
      onSelect={onSelectTab ?? (() => undefined)}
    />
  )
}

/**
 * Bar rendered at the top of the main content area (right of the sidebar).
 *
 * Shows the sidebar toggle, view toggle (panels / dashboard), view label,
 * and the window-level tab bar (auto-hidden when 1 tab).
 *
 * @see Issue #114: Cross-project workspace dashboard
 * @see Issue #8: Window tab bar integration
 */
export function PanelHeaderBar({
  mainView,
  onViewChange,
  onToggleSidebar,
  sidebarCollapsed,
  windowLayout,
  onSelectWindowTab,
  onCloseWindowTab,
  onNewWindowTab,
  onReorderWindowTabs,
}: {
  readonly mainView: MainView
  readonly onViewChange: (view: MainView) => void
  readonly onToggleSidebar?: (() => void) | undefined
  readonly sidebarCollapsed?: boolean
  readonly windowLayout?: WindowLayout | undefined
  readonly onSelectWindowTab?: ((tabId: string) => void) | undefined
  readonly onCloseWindowTab?: (() => void) | undefined
  readonly onNewWindowTab?: (() => void) | undefined
  readonly onReorderWindowTabs?:
    | ((fromIndex: number, toIndex: number) => void)
    | undefined
}) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b px-2">
      {/* Left: sidebar toggle + view toggle + view label */}
      <div className="flex items-center gap-2">
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
        <div className="flex gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Terminal panels"
                  className={mainView === 'panels' ? 'bg-accent' : ''}
                  onClick={() => onViewChange('panels')}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Terminal className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Terminal panels</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Dashboard"
                  className={mainView === 'dashboard' ? 'bg-accent' : ''}
                  onClick={() => onViewChange('dashboard')}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <LayoutDashboard className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent>Dashboard</TooltipContent>
          </Tooltip>
        </div>
        <div className="min-w-0 truncate text-muted-foreground text-xs">
          <ViewContextLabel mainView={mainView} />
        </div>
      </div>

      {/* Right: window tab bar (auto-hides with 1 tab) */}
      {mainView === 'panels' && (
        <WindowTabBar
          onCloseTab={onCloseWindowTab}
          onNewTab={onNewWindowTab}
          onReorderTabs={onReorderWindowTabs}
          onSelectTab={onSelectWindowTab}
          windowLayout={windowLayout}
        />
      )}
    </div>
  )
}
