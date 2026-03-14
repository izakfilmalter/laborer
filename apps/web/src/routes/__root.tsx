import { HotkeysProvider } from '@tanstack/react-hotkeys'
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import { AtomRegistryProvider } from '@/atoms/provider'
import { AppSettingsProvider } from '@/components/app-settings-context'
import { AppSettingsModal } from '@/components/app-settings-modal'
import { DockerStatusBanner } from '@/components/docker-status-banner'
import Header from '@/components/header'
import { LifecyclePhaseProvider } from '@/components/lifecycle-phase-context'
import { SyncStatusBridge } from '@/components/sync-status-bridge'
import { SyncStatusProvider } from '@/components/sync-status-context'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PhaseTransitionDriver } from '@/hooks/use-phase-transition-driver'
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
      <LifecyclePhaseProvider>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          disableTransitionOnChange
          storageKey="vite-ui-theme"
        >
          <HotkeysProvider>
            <TooltipProvider>
              <AtomRegistryProvider>
                <AppSettingsProvider>
                  <SyncStatusProvider>
                    <div className="grid h-svh grid-rows-[auto_auto_1fr]">
                      <Header />
                      <DockerStatusBanner />
                      <LiveStoreProvider>
                        <SyncStatusBridge />
                        <AppSettingsModal />
                        <Outlet />
                      </LiveStoreProvider>
                    </div>
                  </SyncStatusProvider>
                </AppSettingsProvider>
              </AtomRegistryProvider>
              <Toaster richColors />
              <PhaseTransitionDriver />
              <SidecarCrashListener />
            </TooltipProvider>
          </HotkeysProvider>
        </ThemeProvider>
      </LifecyclePhaseProvider>
      <TanStackRouterDevtools position="bottom-left" />
    </>
  )
}
