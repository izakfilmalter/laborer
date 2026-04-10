import type { ReactNode } from 'react'

import AppSidebar from '@/components/app-sidebar'
import { Sidebar, SidebarProvider, SidebarRail } from '@/components/ui/sidebar'

const APP_SIDEBAR_WIDTH_STORAGE_KEY = 'laborer.sidebar.width'
const APP_SIDEBAR_MIN_WIDTH = 13 * 16
const APP_MAIN_CONTENT_MIN_WIDTH = 42 * 16

interface AppSidebarLayoutProps {
  children: ReactNode
}

export function AppSidebarLayout({ children }: AppSidebarLayoutProps) {
  return (
    <SidebarProvider defaultOpen>
      <Sidebar
        className="border-border border-r bg-card text-foreground"
        collapsible="offcanvas"
        resizable={{
          minWidth: APP_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: ({ nextWidth, wrapper }) =>
            wrapper.clientWidth - nextWidth >= APP_MAIN_CONTENT_MIN_WIDTH,
          storageKey: APP_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
        side="left"
      >
        <AppSidebar />
        <SidebarRail />
      </Sidebar>
      {children}
    </SidebarProvider>
  )
}
