import { Toaster } from '@laborer/ui/components/sonner'
import { TooltipProvider } from '@laborer/ui/components/tooltip'
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
import { ConnectionReconnectBanner } from '@/components/connection-reconnect-banner'
import { DesktopUpdateToastListener } from '@/components/desktop-update-toast-listener'
import { LifecyclePhaseProvider } from '@/components/lifecycle-phase-context'
import { ServerGate } from '@/components/server-gate'
import { SharedCollectionCoordinator } from '@/components/shared-collection-coordinator'
import { ThemeProvider } from '@/components/theme-provider'
import { useBeforeQuit } from '@/hooks/use-before-quit'
import { useConfirmBeforeUnload } from '@/hooks/use-confirm-before-unload'
import { PhaseTransitionDriver } from '@/hooks/use-phase-transition-driver'
import { useSidecarCrashListener } from '@/hooks/use-sidecar-crash-listener'
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

  // Browser hosts never deliver ⌘W/⌘Q to the page, so the only warning left
  // before the tab (and every running terminal) disappears is `beforeunload`.
  useConfirmBeforeUnload()

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
              <ServerGate>
                <AtomRegistryProvider>
                  <SharedCollectionCoordinator />
                  <ConnectionReconnectBanner />
                  <AppSettingsProvider>
                    <div className="h-svh">
                      <AppSettingsModal />
                      <Outlet />
                    </div>
                  </AppSettingsProvider>
                  <Toaster richColors />
                  <PhaseTransitionDriver />
                  <BeforeQuitHandler />
                  <SidecarCrashListener />
                  <DesktopUpdateToastListener />
                </AtomRegistryProvider>
              </ServerGate>
            </TooltipProvider>
          </HotkeysProvider>
        </ThemeProvider>
      </LifecyclePhaseProvider>
      <TanStackRouterDevtools position="bottom-right" />
    </>
  )
}
