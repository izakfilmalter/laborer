import { createFileRoute } from '@tanstack/react-router'

import { SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'

export const Route = createFileRoute('/')({
  component: HomeComponent,
})

function HomeComponent() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        <header className="border-border border-b px-3 py-2 md:hidden">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0" />
            <span className="font-medium text-foreground text-sm">Threads</span>
          </div>
        </header>

        <div className="drag-region hidden h-[52px] shrink-0 items-center border-border border-b px-5 md:flex">
          <span className="text-muted-foreground/50 text-xs">
            No active thread
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">
              Select a thread or create a new one to get started.
            </p>
          </div>
        </div>
      </div>
    </SidebarInset>
  )
}
