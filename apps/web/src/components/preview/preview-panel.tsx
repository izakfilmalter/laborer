// biome-ignore-all lint/complexity/noVoid: preview controls dispatch best-effort desktop commands without blocking interaction.
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: the preview view is ported as one state-machine surface so chrome and overlay conditions remain co-located.
import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import type { DesktopPreviewColorScheme } from '@laborer/shared/desktop-bridge'
import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewViewportSetting,
} from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@laborer/ui/components/dropdown-menu'
import { Input } from '@laborer/ui/components/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { cn } from '@laborer/ui/lib/utils'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Globe,
  History,
  Laptop,
  LoaderCircle,
  MoreVertical,
  MousePointerClick,
  PictureInPicture2,
  RadioTower,
  RotateCw,
  Smartphone,
} from 'lucide-react'
import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import { useBrowserPointerStore } from '@/browser/browser-pointer-store'
import {
  startBrowserRecording,
  stopBrowserRecording,
  useBrowserRecordingStore,
} from '@/browser/browser-recording'
import { BrowserSurfaceSlot } from '@/browser/browser-surface-slot'
import { toast } from '@/lib/toast'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'
import {
  emptyWorkspacePreviewState,
  previewRuntimeTabId,
  usePreviewStateStore,
} from '@/preview-state-store'
import { useRightPanelStore } from '@/right-panel-store'
import { mergePreviewServers } from './preview-empty-state-logic'

const openMutation = BrowserDaemonClient.mutation('preview.open')
const navigateMutation = BrowserDaemonClient.mutation('preview.navigate')
const resizeMutation = BrowserDaemonClient.mutation('preview.resize')
const refreshMutation = BrowserDaemonClient.mutation('preview.refresh')
const deliverAnnotationMutation = BrowserDaemonClient.mutation(
  'browserContext.deliver'
)
const discoveredAtom = Atom.family((key: string) => {
  const { configuredUrls, workspaceId } = JSON.parse(key) as {
    readonly configuredUrls: readonly string[]
    readonly workspaceId: string
  }
  return BrowserDaemonClient.query('preview.discoveredLocalServers', {
    configuredUrls,
    workspaceId,
  })
})
const LOCAL_PREVIEW_URL = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i

function normalizePreviewUrl(input: string): string {
  const trimmed = input.trim()
  if (URL.canParse(trimmed)) {
    return new URL(trimmed).href
  }
  const isLocal = LOCAL_PREVIEW_URL.test(trimmed)
  return new URL(`${isLocal ? 'http' : 'https'}://${trimmed}`).href
}

function EmptyState(props: {
  readonly configuredUrls: readonly string[]
  readonly onOpen: (url: string) => void
  readonly recentUrls: readonly string[]
  readonly workspaceId: string
}) {
  const result = useAtomValue(
    discoveredAtom(
      JSON.stringify({
        configuredUrls: props.configuredUrls,
        workspaceId: props.workspaceId,
      })
    )
  )
  const servers = AsyncResult.isSuccess(result)
    ? mergePreviewServers(
        result.value.items.at(-1)?.servers ?? [],
        props.configuredUrls
      )
    : []
  if (servers.length === 0 && props.recentUrls.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <div className="flex size-10 items-center justify-center rounded-lg bg-muted">
          <Globe className="size-4.5 text-muted-foreground" />
        </div>
        <h2 className="font-medium text-sm">No preview yet</h2>
        <p className="max-w-sm text-muted-foreground text-sm">
          Type a URL above, or run a dev script. Browser-ready localhost servers
          will show up here automatically.
        </p>
      </div>
    )
  }
  return (
    <div className="h-full overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        {props.recentUrls.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 font-medium text-muted-foreground text-sm">
              <History className="size-4" /> Recently used
            </h2>
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
              {props.recentUrls.slice(0, 8).map((url) => (
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                  key={url}
                  onClick={() => props.onOpen(url)}
                  type="button"
                >
                  <Globe className="size-4 text-muted-foreground" />
                  <span className="min-w-0 truncate text-sm">{url}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {servers.length > 0 ? (
          <section className="flex flex-col gap-3">
            <h2 className="flex items-center gap-2 font-medium text-muted-foreground text-sm">
              <RadioTower className="size-4" /> Local servers
            </h2>
            <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
              {servers.map((server) => (
                <button
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/50"
                  key={`${server.host}:${server.port}`}
                  onClick={() => props.onOpen(server.requestedUrl)}
                  type="button"
                >
                  <span className="flex size-8 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-500">
                    <RadioTower className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {server.processName ?? 'Listening'}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {server.host}:{server.port}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <p className="px-1 text-muted-foreground text-xs">
              Select a live local server to open it in this browser tab.
            </p>
          </section>
        ) : null}
      </div>
    </div>
  )
}

function MoreMenu(props: {
  readonly colorScheme: DesktopPreviewColorScheme
  readonly hasWebContents: boolean
  readonly onViewport: (viewport: PreviewViewportSetting) => void
  readonly runtimeTabId: string | null
  readonly viewport: PreviewViewportSetting
  readonly zoomFactor: number
}) {
  const preview = window.desktopBridge?.preview
  if (!preview) {
    return null
  }
  const disabled = !(props.runtimeTabId && props.hasWebContents)
  const call = (operation: (tabId: string) => Promise<void>) => () => {
    if (props.runtimeTabId) {
      void operation(props.runtimeTabId)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Preview menu"
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        <MoreVertical />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem
          disabled={disabled}
          onClick={call(preview.hardReload)}
        >
          Hard reload
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onClick={call(preview.openDevTools)}
        >
          Open DevTools
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={disabled}
          onClick={call(preview.pictureInPicture.open)}
        >
          Open separate preview window
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Base UI anchors a group label to its group, so each label lives
            inside the group it names rather than above it. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Viewport</DropdownMenuLabel>
          <DropdownMenuItem
            disabled={disabled}
            onClick={() => props.onViewport(FILL_PREVIEW_VIEWPORT)}
          >
            <Laptop /> Fill panel
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={disabled}
            onClick={() =>
              props.onViewport({
                _tag: 'preset',
                presetId: 'iphone-12-pro',
                width: 390,
                height: 844,
              })
            }
          >
            <Smartphone /> iPhone 12 Pro
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={disabled}
            onClick={() =>
              props.onViewport({ _tag: 'freeform', width: 1280, height: 800 })
            }
          >
            <Laptop /> Responsive viewport
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          onValueChange={(value) =>
            props.runtimeTabId &&
            void preview.setColorScheme(
              props.runtimeTabId,
              value as DesktopPreviewColorScheme
            )
          }
          value={props.colorScheme}
        >
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          {(['system', 'light', 'dark'] as const).map((value) => (
            <DropdownMenuRadioItem key={value} value={value}>
              {value[0]?.toUpperCase()}
              {value.slice(1)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={disabled} onClick={call(preview.zoomOut)}>
          Zoom out{' '}
          <span className="ml-auto text-muted-foreground">
            {Math.round(props.zoomFactor * 100)}%
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onClick={call(preview.zoomIn)}>
          Zoom in
        </DropdownMenuItem>
        <DropdownMenuItem disabled={disabled} onClick={call(preview.resetZoom)}>
          Reset zoom
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void preview.clearCookies()}>
          Clear cookies
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void preview.clearCache()}>
          Clear cache
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ChromeButton(props: {
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
  readonly children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            size="icon-xs"
            type="button"
            variant="ghost"
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  )
}

export function PreviewPanel(props: {
  readonly configuredUrls?: readonly string[]
  readonly tabId: string | null
  readonly visible: boolean
  readonly workspaceId: string
}) {
  const previewState = usePreviewStateStore(
    (state) =>
      state.byWorkspaceId[props.workspaceId] ?? emptyWorkspacePreviewState
  )
  const snapshot = props.tabId
    ? (previewState.sessions[props.tabId] ?? null)
    : null
  const overlay = props.tabId
    ? (previewState.desktopByTabId[props.tabId] ?? null)
    : null
  const runtimeTabId = props.tabId
    ? previewRuntimeTabId(
        props.workspaceId,
        previewState.serverEpoch,
        props.tabId
      )
    : null
  const navStatus = snapshot?.navStatus ?? { _tag: 'Idle' as const }
  const url = navStatus._tag === 'Idle' ? '' : navStatus.url
  const [draft, setDraft] = useState(url)
  const [focused, setFocused] = useState(false)
  const [pickActive, setPickActive] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const open = useAtomSet(openMutation, { mode: 'promise' })
  const navigate = useAtomSet(navigateMutation, { mode: 'promise' })
  const resize = useAtomSet(resizeMutation, { mode: 'promise' })
  const refresh = useAtomSet(refreshMutation, { mode: 'promise' })
  const deliverAnnotation = useAtomSet(deliverAnnotationMutation, {
    mode: 'promise',
  })
  const preview = window.desktopBridge?.preview
  const loading = overlay?.loading ?? navStatus._tag === 'Loading'
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT
  const pointer = useBrowserPointerStore((state) =>
    runtimeTabId ? state.byTabId[runtimeTabId] : undefined
  )
  const recordingTabId = useBrowserRecordingStore((state) => state.activeTabId)
  const recording = runtimeTabId !== null && recordingTabId === runtimeTabId
  const miniPlayer = usePreviewMiniPlayerStore(
    (state) => state.byWorkspaceId[props.workspaceId] ?? null
  )

  const submitUrl = useCallback(
    async (raw: string) => {
      try {
        const next = normalizePreviewUrl(raw)
        if (props.tabId && runtimeTabId) {
          const updated = await navigate({
            payload: {
              workspaceId: props.workspaceId,
              tabId: props.tabId,
              url: next,
            },
          })
          usePreviewStateStore.getState().upsert(props.workspaceId, updated)
          await preview?.navigate(runtimeTabId, next)
        } else {
          const opened = await open({
            payload: { workspaceId: props.workspaceId, url: next },
          })
          usePreviewStateStore.getState().upsert(props.workspaceId, opened)
          useRightPanelStore
            .getState()
            .openBrowser(props.workspaceId, opened.tabId)
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : 'Unable to open preview'
        )
      }
    },
    [navigate, open, preview, props.tabId, props.workspaceId, runtimeTabId]
  )

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (draft.trim()) {
      void submitUrl(draft)
    }
    inputRef.current?.blur()
  }
  const handleRefresh = () => {
    if (!(props.tabId && runtimeTabId && preview)) {
      return
    }
    if (loading) {
      void preview.stop(runtimeTabId)
    } else {
      void refresh({
        payload: { workspaceId: props.workspaceId, tabId: props.tabId },
      })
      void preview.refresh(runtimeTabId)
    }
  }
  const handleViewport = (next: PreviewViewportSetting) => {
    if (!props.tabId) {
      return
    }
    void resize({
      payload: {
        workspaceId: props.workspaceId,
        tabId: props.tabId,
        viewport: next,
      },
    }).then((updated) =>
      usePreviewStateStore.getState().upsert(props.workspaceId, updated)
    )
  }
  const handleCapture = () => {
    if (!(runtimeTabId && preview)) {
      return
    }
    void preview.captureScreenshot(runtimeTabId).then(
      (artifact) => toast.success(`Screenshot saved to ${artifact.path}`),
      () => toast.error('Unable to capture screenshot')
    )
  }
  const handleRecording = () => {
    if (!runtimeTabId) {
      return
    }
    if (recording) {
      void stopBrowserRecording().then(
        (artifact) => {
          if (artifact) {
            toast.success(`Recording saved to ${artifact.path}`)
          }
        },
        () => toast.error('Unable to stop recording')
      )
      return
    }
    void startBrowserRecording(runtimeTabId).catch(() =>
      toast.error('Unable to start recording')
    )
  }
  const handlePick = () => {
    if (!(runtimeTabId && preview)) {
      return
    }
    if (pickActive) {
      void preview.cancelPickElement(runtimeTabId)
      setPickActive(false)
      return
    }
    setPickActive(true)
    void preview
      .pickElement(runtimeTabId)
      .then((result) => {
        if (!result) {
          return
        }
        return deliverAnnotation({
          payload: {
            workspaceId: props.workspaceId,
            annotation: result.annotation,
          },
        })
          .then(() =>
            toast.success('Annotation delivered to the workspace agent')
          )
          .catch(async () => {
            if (!navigator.clipboard) {
              throw new Error('Clipboard is unavailable')
            }
            await navigator.clipboard.writeText(
              JSON.stringify(result.annotation, null, 2)
            )
            toast.error('Unable to deliver annotation; copied to clipboard')
          })
      })
      .catch(() => toast.error('Unable to deliver annotation'))
      .finally(() => setPickActive(false))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="relative shrink-0">
        <form
          className="flex h-10 min-h-10 items-center gap-1 border-border/60 border-b px-2"
          data-surface-subheader
          onSubmit={handleSubmit}
        >
          <fieldset
            aria-label="Navigation"
            className="flex items-center gap-0.5 border-0 p-0"
          >
            <ChromeButton
              disabled={!overlay?.canGoBack}
              label="Back"
              onClick={() => runtimeTabId && void preview?.goBack(runtimeTabId)}
            >
              <ArrowLeft />
            </ChromeButton>
            <ChromeButton
              disabled={!overlay?.canGoForward}
              label="Forward"
              onClick={() =>
                runtimeTabId && void preview?.goForward(runtimeTabId)
              }
            >
              <ArrowRight />
            </ChromeButton>
            <ChromeButton
              disabled={!props.tabId}
              label={loading ? 'Stop' : 'Refresh'}
              onClick={handleRefresh}
            >
              {loading ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <RotateCw />
              )}
            </ChromeButton>
          </fieldset>
          <div className="group/address relative min-w-0 flex-1">
            <Input
              className="h-7 border-transparent bg-muted/60 pr-7 text-xs shadow-none focus-visible:border-ring"
              data-preview-url-input
              onBlur={() => setFocused(false)}
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => {
                setDraft(url)
                setFocused(true)
                queueMicrotask(() => inputRef.current?.select())
              }}
              placeholder="Search or enter URL"
              ref={inputRef}
              spellCheck={false}
              value={focused ? draft : url}
            />
            {url && !focused ? (
              <button
                aria-label="Open in system browser"
                className="absolute inset-y-0 right-1 text-muted-foreground opacity-0 group-hover/address:opacity-100"
                onClick={() => void window.desktopBridge?.openExternal(url)}
                type="button"
              >
                <ExternalLink className="size-3.5" />
              </button>
            ) : null}
          </div>
          {props.tabId ? (
            <ChromeButton
              disabled={navStatus._tag === 'LoadFailed'}
              label={pickActive ? 'Cancel annotation' : 'Annotate preview'}
              onClick={handlePick}
            >
              <MousePointerClick className={cn(pickActive && 'text-primary')} />
            </ChromeButton>
          ) : null}
          {props.tabId ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={
                      recording ? 'Stop recording' : 'Capture screenshot'
                    }
                    className="relative"
                    disabled={!overlay?.hasWebContents}
                    onClick={(event) =>
                      event.shiftKey || recording
                        ? handleRecording()
                        : handleCapture()
                    }
                    size="icon-xs"
                    type="button"
                    variant={recording ? 'secondary' : 'ghost'}
                  />
                }
              >
                <Camera className={cn(recording && 'text-destructive')} />
                {recording ? (
                  <span className="absolute top-0.5 right-0.5 size-1.5 animate-pulse rounded-full bg-destructive" />
                ) : null}
              </TooltipTrigger>
              <TooltipContent>
                {recording
                  ? 'Stop recording'
                  : 'Screenshot · Shift-click to record'}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {props.tabId ? (
            <ChromeButton
              disabled={!overlay?.hasWebContents}
              label={
                miniPlayer?.tabId === props.tabId
                  ? 'Close floating preview'
                  : 'Float preview over workspace'
              }
              onClick={() => {
                if (!props.tabId) {
                  return
                }
                if (miniPlayer?.tabId === props.tabId) {
                  usePreviewMiniPlayerStore.getState().close(props.workspaceId)
                  return
                }
                usePreviewMiniPlayerStore
                  .getState()
                  .open(props.workspaceId, props.tabId)
                useRightPanelStore.getState().close(props.workspaceId)
              }}
            >
              <PictureInPicture2 />
            </ChromeButton>
          ) : null}
          <MoreMenu
            colorScheme={overlay?.colorScheme ?? 'system'}
            hasWebContents={overlay?.hasWebContents ?? false}
            onViewport={handleViewport}
            runtimeTabId={runtimeTabId}
            viewport={viewport}
            zoomFactor={overlay?.zoomFactor ?? 1}
          />
        </form>
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 bg-primary transition-all',
            loading ? 'w-2/3 animate-pulse' : 'w-0'
          )}
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && navStatus._tag !== 'Idle' ? (
          <BrowserSurfaceSlot
            className="absolute inset-0 size-full"
            tabId={runtimeTabId}
            visible={props.visible && navStatus._tag !== 'LoadFailed'}
          />
        ) : null}
        {!snapshot || navStatus._tag === 'Idle' ? (
          <EmptyState
            configuredUrls={props.configuredUrls ?? []}
            onOpen={(next) => void submitUrl(next)}
            recentUrls={previewState.recentlySeenUrls}
            workspaceId={props.workspaceId}
          />
        ) : null}
        {overlay && overlay.zoomFactor !== 1 ? (
          <div className="pointer-events-none absolute right-3 bottom-3 z-30 rounded-md border bg-background/90 px-2 py-1 text-xs shadow-sm">
            {Math.round(overlay.zoomFactor * 100)}%
          </div>
        ) : null}
        {overlay?.controller !== 'none' ? (
          <div className="pointer-events-none absolute top-3 left-3 z-30 rounded-full border bg-background/90 px-2.5 py-1 font-medium text-[11px] shadow-sm">
            {overlay?.controller === 'agent'
              ? 'Agent controlling browser'
              : 'Human control'}
          </div>
        ) : null}
        {pointer && overlay?.controller === 'agent' ? (
          <div
            className="pointer-events-none absolute z-30 transition-[left,top] duration-75"
            style={{ left: pointer.x, top: pointer.y }}
          >
            <MousePointerClick className="size-5 fill-primary text-primary-foreground drop-shadow" />
          </div>
        ) : null}
        {navStatus._tag === 'LoadFailed' ? (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-background p-8 text-center">
            <Globe className="size-8 text-muted-foreground" />
            <h2 className="font-medium">This site can’t be reached</h2>
            <p className="max-w-md text-muted-foreground text-sm">
              {navStatus.description}
            </p>
            <Button onClick={handleRefresh} size="sm" variant="outline">
              Try again
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
