import { HotkeysProvider } from '@tanstack/react-hotkeys'
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { useEffect, useState } from 'react'
import { AtomRegistryProvider } from '@/atoms/provider'
import { DockerStatusBanner } from '@/components/docker-status-banner'
import Header from '@/components/header'
import Loader from '@/components/loader'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useSidecarCrashListener } from '@/hooks/use-sidecar-crash-listener'
import { waitForSidecars } from '@/lib/desktop'
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

/**
 * Gate that waits for sidecar services to become healthy before
 * rendering children. In Electron, the main process handles health
 * checking before showing the window, so this resolves immediately.
 * In plain browser mode, also resolves immediately.
 */
function SidecarGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    console.log('[SidecarGate] origin:', globalThis.location?.origin)
    console.log('[SidecarGate] Waiting for sidecars...')
    waitForSidecars().then(
      () => {
        console.log('[SidecarGate] Sidecars ready')
        setReady(true)
      },
      (error) => {
        console.error('[SidecarGate] Sidecar initialization failed:', error)
        setReady(true)
      }
    )
  }, [])

  if (!ready) {
    return <Loader />
  }

  return children
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
            <SidecarGate>
              <AtomRegistryProvider>
                <LiveStoreProvider>
                  <div className="grid h-svh grid-rows-[auto_auto_1fr]">
                    <Header />
                    <DockerStatusBanner />
                    <Outlet />
                  </div>
                </LiveStoreProvider>
              </AtomRegistryProvider>
            </SidecarGate>
            <Toaster richColors />
            <SidecarCrashListener />
          </TooltipProvider>
        </HotkeysProvider>
      </ThemeProvider>
      <TanStackRouterDevtools position="bottom-left" />
    </>
  )
}
