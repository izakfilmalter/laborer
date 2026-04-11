import { createFileRoute } from '@tanstack/react-router'

import { WorkspaceTerminalWorkspace } from '@/components/thread-terminal-workspace'
import { SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import {
  useActiveWorkspaceInfo,
  useProjectsSnapshot,
  useProjectsSyncReady,
} from '@/rpc/project-state'

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  const activeWorkspaceInfo = useActiveWorkspaceInfo()
  const projectsSnapshot = useProjectsSnapshot()
  const isProjectsSyncReady = useProjectsSyncReady()
  const isConnecting =
    !isProjectsSyncReady && projectsSnapshot.projects.length === 0
  const mobileTitle =
    activeWorkspaceInfo?.workspace.name ??
    (isConnecting ? 'Connecting...' : 'Workspaces')

  let headerSubtitle = 'No active workspace'
  let emptyStateMessage =
    'Select a workspace or create a new one to get started.'

  if (activeWorkspaceInfo) {
    headerSubtitle = `${activeWorkspaceInfo.project.name} · ${activeWorkspaceInfo.workspace.workspaceRoot}`
  } else if (isConnecting) {
    headerSubtitle = 'Connecting to the Laborer server...'
    emptyStateMessage = 'Connecting to the server...'
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        <header className="border-border border-b px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="font-medium text-foreground text-sm">
              {mobileTitle}
            </span>
          </div>
        </header>

        <div className="drag-region hidden h-[52px] shrink-0 items-center border-border border-b px-5 md:flex">
          <span className="text-muted-foreground/50 text-xs">
            {headerSubtitle}
          </span>
        </div>

        {activeWorkspaceInfo ? (
          <WorkspaceTerminalWorkspace
            cwd={activeWorkspaceInfo.workspace.workspaceRoot}
            projectName={activeWorkspaceInfo.project.name}
            workspaceId={activeWorkspaceInfo.workspace.id}
            workspaceName={activeWorkspaceInfo.workspace.name}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center">
              <p className="text-sm">{emptyStateMessage}</p>
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  )
}
