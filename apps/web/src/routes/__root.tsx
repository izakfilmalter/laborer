import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { AppSidebarLayout } from '@/components/app-sidebar-layout'
import { ThemeProvider } from '@/components/theme-provider'
import '../index.css'
import { ProjectsStateBootstrap } from '@/rpc/project-state-bootstrap'
import { ServerStateBootstrap } from '@/rpc/server-state-bootstrap'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export type RouterAppContext = Record<string, never>

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: 'my-better-t-app',
      },
      {
        name: 'description',
        content: 'my-better-t-app is a web application',
      },
    ],
    links: [
      {
        rel: 'icon',
        href: '/favicon.ico',
      },
    ],
  }),
})

function RootComponent() {
  return (
    <>
      <HeadContent />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        storageKey="vite-ui-theme"
      >
        <ServerStateBootstrap />
        <ProjectsStateBootstrap />
        <TooltipProvider>
          <AppSidebarLayout>
            <Outlet />
          </AppSidebarLayout>

          <Toaster richColors />
        </TooltipProvider>
      </ThemeProvider>
      {import.meta.env.DEV ? (
        <TanStackRouterDevtools position="bottom-right" />
      ) : null}
    </>
  )
}
