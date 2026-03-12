import {
  LayoutDashboard,
  PanelLeftClose,
  PanelLeftOpen,
  Terminal,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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

/**
 * Bar rendered at the top of the main content area (right of the sidebar).
 *
 * Shows the sidebar toggle, view toggle (panels / dashboard), and view label.
 * Per-pane actions (split, close, diff, dev server) are now in per-workspace
 * frame headers instead.
 *
 * @see Issue #114: Cross-project workspace dashboard
 */
export function PanelHeaderBar({
  mainView,
  onViewChange,
  onToggleSidebar,
  sidebarCollapsed,
}: {
  readonly mainView: MainView
  readonly onViewChange: (view: MainView) => void
  readonly onToggleSidebar?: (() => void) | undefined
  readonly sidebarCollapsed?: boolean
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
    </div>
  )
}
