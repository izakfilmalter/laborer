// biome-ignore-all lint/complexity/noVoid: desktop bridge commands are intentionally fire-and-forget renderer effects.
import { useAtomSet } from '@effect/atom-react/Hooks'
import type {
  DesktopPreviewNavStatus,
  DesktopPreviewWebviewConfig,
} from '@laborer/shared/desktop-bridge'
import { FILL_PREVIEW_VIEWPORT } from '@laborer/shared/rpc'
import { useEffect, useState } from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import {
  previewRuntimeTabId,
  usePreviewStateStore,
} from '@/preview-state-store'
import { useBrowserPointerStore } from './browser-pointer-store'
import { useBrowserSurfaceStore } from './browser-surface-store'

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
  const presentation = useBrowserSurfaceStore(
    (state) => state.byTabId[props.runtimeTabId]
  )

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

  useEffect(() => {
    if (!preview) {
      return
    }
    void preview.createTab(props.runtimeTabId)
    return () => {
      usePreviewStateStore
        .getState()
        .applyDesktopState(props.workspaceId, props.serverTabId, null)
      void preview.closeTab(props.runtimeTabId)
    }
  }, [preview, props.runtimeTabId, props.serverTabId, props.workspaceId])

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
  const width =
    props.viewport._tag === 'fill'
      ? (rect?.width ?? 1280)
      : props.viewport.width
  const height =
    props.viewport._tag === 'fill'
      ? (rect?.height ?? 800)
      : props.viewport.height

  return (
    <div
      className="fixed overflow-auto bg-muted/35"
      data-preview-viewport={props.runtimeTabId}
      style={
        active && rect
          ? {
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              zIndex: 20,
              borderRadius: presentation?.cornerRadius,
            }
          : { left: -100_000, top: 0, width, height, visibility: 'hidden' }
      }
    >
      <webview
        allowpopups
        aria-hidden={active ? undefined : true}
        className="flex bg-background"
        data-preview-server-tab={props.serverTabId}
        data-preview-tab={props.runtimeTabId}
        partition={config.partition}
        preload={config.preloadUrl ?? undefined}
        ref={(node) => {
          if (!node) {
            return
          }
          const webview = node as unknown as ElectronWebview
          const register = () => {
            const id = webview.getWebContentsId()
            if (Number.isInteger(id) && id > 0) {
              void preview.registerWebview(props.runtimeTabId, id)
            }
          }
          webview.addEventListener('did-attach', register, { once: true })
          webview.addEventListener('dom-ready', register, { once: true })
        }}
        src={props.initialUrl ?? 'about:blank'}
        style={{ width, height }}
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
