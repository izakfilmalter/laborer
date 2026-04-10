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
import { LifecyclePhaseProvider } from '@/components/lifecycle-phase-context'
import { ProviderStatusBanner } from '@/components/provider-status-banner'
import { SidecarRuntimeBoundary } from '@/components/sidecar-runtime-boundary'
import { SyncStatusBridge } from '@/components/sync-status-bridge'
import { SyncStatusProvider } from '@/components/sync-status-context'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useBeforeQuit } from '@/hooks/use-before-quit'
import { PhaseTransitionDriver } from '@/hooks/use-phase-transition-driver'
import { useSidecarCrashListener } from '@/hooks/use-sidecar-crash-listener'
import { LiveStoreProvider } from '@/livestore/provider'
import { QuitAppDialog } from '@/routes/-components/close-dialogs'

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

/**
 * Handles quit negotiation with the main process and renders the
 * confirmation dialog when running terminals would be killed.
 */
function BeforeQuitHandler() {
  const { isQuitDialogOpen, runningTerminalCount, confirmQuit, cancelQuit } =
    useBeforeQuit()

  return (
    <QuitAppDialog
      onConfirm={confirmQuit}
      onOpenChange={(open: boolean) => {
        if (!open) {
          cancelQuit()
        }
      }}
      open={isQuitDialogOpen}
      runningTerminalCount={runningTerminalCount}
    />
  )
}

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
              <SidecarRuntimeBoundary>
                {(generation) => (
                  <AtomRegistryProvider key={`atom-registry-${generation}`}>
                    <AppSettingsProvider>
                      <SyncStatusProvider>
                        <div className="grid h-svh grid-rows-[auto_1fr]">
                          <ProviderStatusBanner />
                          <LiveStoreProvider key={`livestore-${generation}`}>
                            <SyncStatusBridge />
                            <AppSettingsModal />
                            <Outlet />
                          </LiveStoreProvider>
                        </div>
                      </SyncStatusProvider>
                    </AppSettingsProvider>
                    <Toaster richColors />
                    <PhaseTransitionDriver />
                    <BeforeQuitHandler />
                    <SidecarCrashListener />
                  </AtomRegistryProvider>
                )}
              </SidecarRuntimeBoundary>
            </TooltipProvider>
          </HotkeysProvider>
        </ThemeProvider>
      </LifecyclePhaseProvider>
      <TanStackRouterDevtools position="bottom-right" />
    </>
  )
}
