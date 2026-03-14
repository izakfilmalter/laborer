import { HotkeysProvider } from '@tanstack/react-hotkeys'
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { AtomRegistryProvider } from '@/atoms/provider'
import { DockerStatusBanner } from '@/components/docker-status-banner'
import Header from '@/components/header'
import { ServerGate } from '@/components/server-gate'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidecarCrashListener } from '@/hooks/use-sidecar-crash-listener'
import { LiveStoreProvider } from '@/livestore/provider'

import '../index.css'

export type RouterAppContext = Record<string, never>

export const Route = createRootRouteWithContext<RouterAppContext>()({
  component: RootComponent,
  head: () => ({
    meta: [
      {
        title: 'laborer',
      },
      {
        name: 'description',
        content: 'laborer is a web application',
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

/** Renderless component that listens for sidecar crash/recovery events via DesktopBridge. */
function SidecarCrashListener(): null {
  useSidecarCrashListener()
  return null
}

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
        <HotkeysProvider>
          <TooltipProvider>
            <AtomRegistryProvider>
              <div className="grid h-svh grid-rows-[auto_auto_1fr]">
                <Header />
                <DockerStatusBanner />
                <ServerGate>
                  <LiveStoreProvider>
                    <Outlet />
                  </LiveStoreProvider>
                </ServerGate>
              </div>
            </AtomRegistryProvider>
            <Toaster richColors />
            <SidecarCrashListener />
          </TooltipProvider>
        </HotkeysProvider>
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-left" />
    </>
  )
}
