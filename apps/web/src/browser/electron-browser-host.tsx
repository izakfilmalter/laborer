// biome-ignore-all lint/complexity/noVoid: desktop bridge commands are intentionally fire-and-forget renderer effects.
import { useAtomSet } from '@effect/atom-react/Hooks'
import type {
  DesktopPreviewNavStatus,
  DesktopPreviewWebviewConfig,
} from '@laborer/shared/desktop-bridge'
import { FILL_PREVIEW_VIEWPORT } from '@laborer/shared/rpc'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import {
  previewRuntimeTabId,
  usePreviewStateStore,
} from '@/preview-state-store'
import { useBrowserPointerStore } from './browser-pointer-store'
import { useBrowserSurfaceStore } from './browser-surface-store'
import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  type WebviewCrashRecoveryState,
} from './webview-crash-recovery'

interface ElectronWebview extends HTMLElement {
  readonly getWebContentsId: () => number
  partition: string
  preload?: string
  src: string
  webpreferences?: string
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview
  }
}

const reportStatusMutation = BrowserDaemonClient.mutation(
  'preview.reportStatus'
)

function toDaemonNavStatus(status: DesktopPreviewNavStatus) {
  switch (status.kind) {
    case 'Idle':
      return { _tag: 'Idle' as const }
    case 'Loading':
    case 'Success':
      return {
        _tag: status.kind,
        title: status.title,
        url: status.url,
      } as const
    case 'LoadFailed':
      return {
        _tag: 'LoadFailed' as const,
        code: status.code,
        description: status.description,
        title: status.title,
        url: status.url,
      }
    default:
      return status satisfies never
  }
}

function HostedBrowserWebview(props: {
  readonly initialUrl: string | null
  readonly runtimeTabId: string
  readonly serverTabId: string
  readonly viewport:
    | typeof FILL_PREVIEW_VIEWPORT
    | {
        readonly _tag: 'freeform' | 'preset'
        readonly width: number
        readonly height: number
      }
  readonly workspaceId: string
}) {
  const preview = window.desktopBridge?.preview
  const reportStatus = useAtomSet(reportStatusMutation, { mode: 'promise' })
  const [config, setConfig] = useState<DesktopPreviewWebviewConfig | null>(null)
  const [webviewGeneration, setWebviewGeneration] = useState(0)
  const crashRecoveryRef = useRef<WebviewCrashRecoveryState>(
    INITIAL_WEBVIEW_CRASH_RECOVERY_STATE
  )
  const latestUrlRef = useRef(props.initialUrl)
  const [tabReady] = useState(() => {
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    return { promise, reject, resolve }
  })
  const presentation = useBrowserSurfaceStore(
    (state) => state.byTabId[props.runtimeTabId]
  )

  useEffect(() => {
    latestUrlRef.current = props.initialUrl
  }, [props.initialUrl])

  useEffect(() => {
    if (!preview) {
      return
    }
    let disposed = false
    void preview.getPreviewConfig(props.workspaceId).then((next) => {
      if (!disposed) {
        setConfig(next)
      }
    })
    return () => {
      disposed = true
    }
  }, [preview, props.workspaceId])

  useLayoutEffect(() => {
    if (!preview) {
      return
    }
    preview
      .createTab(props.runtimeTabId)
      .then(tabReady.resolve, tabReady.reject)
    return () => {
      usePreviewStateStore
        .getState()
        .applyDesktopState(props.workspaceId, props.serverTabId, null)
      void preview.closeTab(props.runtimeTabId)
    }
  }, [
    preview,
    props.runtimeTabId,
    props.serverTabId,
    props.workspaceId,
    tabReady,
  ])

  useEffect(() => {
    if (!preview) {
      return
    }
    return preview.onStateChange((tabId, state) => {
      if (tabId !== props.runtimeTabId) {
        return
      }
      usePreviewStateStore
        .getState()
        .applyDesktopState(props.workspaceId, props.serverTabId, state)
      void reportStatus({
        payload: {
          workspaceId: props.workspaceId,
          tabId: props.serverTabId,
          canGoBack: state.canGoBack,
          canGoForward: state.canGoForward,
          navStatus: toDaemonNavStatus(state.navStatus),
        },
      }).catch(() => undefined)
    })
  }, [
    preview,
    props.runtimeTabId,
    props.serverTabId,
    props.workspaceId,
    reportStatus,
  ])

  if (!(preview && config)) {
    return null
  }
  const active = Boolean(presentation?.visible && presentation.rect)
  const rect = presentation?.rect
  const sourceRect = presentation?.fitSourceContent
    ? presentation.sourceRect
    : null
  const sourceWidth =
    props.viewport._tag === 'fill'
      ? (sourceRect?.width ?? rect?.width ?? 1280)
      : props.viewport.width
  const sourceHeight =
    props.viewport._tag === 'fill'
      ? (sourceRect?.height ?? rect?.height ?? 800)
      : props.viewport.height
  const fitScale =
    active && rect && presentation?.fitSourceContent
      ? Math.min(rect.width / sourceWidth, rect.height / sourceHeight)
      : 1

  return (
    <div
      className="fixed overflow-hidden bg-muted/35"
      data-preview-viewport={props.runtimeTabId}
      style={
        active && rect
          ? {
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              pointerEvents: 'auto',
              zIndex: 30,
              borderRadius: presentation?.cornerRadius,
            }
          : {
              height: sourceHeight,
              left: -100_000,
              pointerEvents: 'none',
              top: -100_000,
              width: sourceWidth,
              zIndex: -1,
            }
      }
    >
      <webview
        allowpopups
        aria-hidden={active ? undefined : true}
        className="flex bg-background"
        data-preview-server-tab={props.serverTabId}
        data-preview-tab={props.runtimeTabId}
        key={webviewGeneration}
        partition={config.partition}
        preload={config.preloadUrl ?? undefined}
        ref={(node) => {
          if (!node) {
            return
          }
          const webview = node as unknown as ElectronWebview
          let disposed = false
          let recoveryTimeout: ReturnType<typeof setTimeout> | null = null
          const register = async () => {
            try {
              await tabReady.promise
              if (disposed) {
                return
              }
              const id = webview.getWebContentsId()
              if (Number.isInteger(id) && id > 0) {
                await preview.registerWebview(props.runtimeTabId, id)
              }
            } catch {
              // did-attach and dom-ready independently retry transient races.
            }
          }
          webview.addEventListener('did-attach', register)
          webview.addEventListener('dom-ready', register)
          const recoverGuest = () => {
            if (disposed || recoveryTimeout !== null) {
              return
            }
            const recovery = planWebviewCrashRecovery(
              crashRecoveryRef.current,
              Date.now()
            )
            if (!recovery) {
              return
            }
            crashRecoveryRef.current = recovery.state
            recoveryTimeout = setTimeout(() => {
              recoveryTimeout = null
              if (!disposed) {
                setWebviewGeneration((generation) => generation + 1)
              }
            }, recovery.delayMs)
          }
          webview.addEventListener('render-process-gone', recoverGuest)
          register()
          return () => {
            disposed = true
            if (recoveryTimeout !== null) {
              clearTimeout(recoveryTimeout)
            }
            webview.removeEventListener('did-attach', register)
            webview.removeEventListener('dom-ready', register)
            webview.removeEventListener('render-process-gone', recoverGuest)
          }
        }}
        src={latestUrlRef.current ?? 'about:blank'}
        style={{
          height: sourceHeight,
          transform: fitScale < 1 ? `scale(${fitScale})` : undefined,
          transformOrigin: 'top left',
          width: sourceWidth,
        }}
        webpreferences={config.webPreferences}
      />
    </div>
  )
}

export function ElectronBrowserHost() {
  const byWorkspaceId = usePreviewStateStore((state) => state.byWorkspaceId)
  const sessions = Object.entries(byWorkspaceId).flatMap(
    ([workspaceId, state]) =>
      Object.values(state.sessions).map((snapshot) => ({
        workspaceId,
        snapshot,
        runtimeTabId: previewRuntimeTabId(
          workspaceId,
          state.serverEpoch,
          snapshot.tabId
        ),
      }))
  )

  useEffect(() => {
    const preview = window.desktopBridge?.preview
    if (!preview) {
      return
    }
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event)
    })
  }, [])

  useEffect(() => {
    const preview = window.desktopBridge?.preview
    if (!preview) {
      return
    }
    const sync = () => {
      const style = getComputedStyle(document.documentElement)
      const value = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback
      void preview.setAnnotationTheme({
        accent: value('--accent', '#27272a'),
        accentForeground: value('--accent-foreground', '#fafafa'),
        background: value('--background', '#09090b'),
        border: value('--border', '#27272a'),
        colorScheme: document.documentElement.classList.contains('light')
          ? 'light'
          : 'dark',
        fontMono: value('--font-mono', 'monospace'),
        fontSans: value('--font-sans', 'sans-serif'),
        foreground: value('--foreground', '#fafafa'),
        input: value('--input', '#27272a'),
        muted: value('--muted', '#27272a'),
        mutedForeground: value('--muted-foreground', '#a1a1aa'),
        popover: value('--popover', '#09090b'),
        popoverForeground: value('--popover-foreground', '#fafafa'),
        primary: value('--primary', '#fafafa'),
        primaryForeground: value('--primary-foreground', '#18181b'),
        radius: value('--radius', '0.5rem'),
        ring: value('--ring', '#71717a'),
      })
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })
    return () => observer.disconnect()
  }, [])

  if (!window.desktopBridge?.preview) {
    return null
  }
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(({ workspaceId, snapshot, runtimeTabId }) => (
        <HostedBrowserWebview
          initialUrl={
            snapshot.navStatus._tag === 'Idle' ? null : snapshot.navStatus.url
          }
          key={runtimeTabId}
          runtimeTabId={runtimeTabId}
          serverTabId={snapshot.tabId}
          viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
          workspaceId={workspaceId}
        />
      ))}
    </div>
  )
}
