import { createFileRoute } from '@tanstack/react-router'

import { SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import {
  useActiveThreadInfo,
  useProjectsSnapshot,
  useProjectsSyncReady,
} from '@/rpc/project-state'

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  const activeThreadInfo = useActiveThreadInfo()
  const projectsSnapshot = useProjectsSnapshot()
  const isProjectsSyncReady = useProjectsSyncReady()
  const isConnecting =
    !isProjectsSyncReady && projectsSnapshot.projects.length === 0
  const mobileTitle =
    activeThreadInfo?.thread.title ??
    (isConnecting ? 'Connecting...' : 'Threads')

  let headerSubtitle = 'No active thread'
  let emptyStateMessage = 'Select a thread or create a new one to get started.'

  if (activeThreadInfo) {
    headerSubtitle = `${activeThreadInfo.project.name} · ${activeThreadInfo.project.workspaceRoot}`
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

        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            {activeThreadInfo ? (
              <>
                <p className="font-medium text-foreground text-sm">
                  {activeThreadInfo.thread.title}
                </p>
                <p className="mt-1 text-sm">
                  Ready to work in `{activeThreadInfo.project.name}`.
                </p>
              </>
            ) : (
              <p className="text-sm">{emptyStateMessage}</p>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  )
}
