import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import Header from '@/components/header'
import { ThemeProvider } from '@/components/theme-provider'
import '../index.css'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export type RouterAppContext = {}

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
        <TooltipProvider>
          <div className="grid h-svh grid-rows-[auto_1fr]">
            <Header />
            <Outlet />
          </div>

          <Toaster richColors />
        </TooltipProvider>
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-left" />
    </>
  )
}
