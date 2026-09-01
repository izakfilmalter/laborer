import { Button } from '@laborer/ui/components/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { PanelRight, PictureInPicture2, X } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { BrowserSurfaceSlot } from '@/browser/browser-surface-slot'
import { useFullscreenPaneId } from '@/panels/panel-context'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'
import {
  emptyWorkspacePreviewState,
  previewRuntimeTabId,
  usePreviewStateStore,
} from '@/preview-state-store'
import { useRightPanelStore } from '@/right-panel-store'
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
} from './preview-mini-player-layout'

interface PointerStart {
  readonly playerX: number
  readonly playerY: number
  readonly pointerId: number
  readonly pointerX: number
  readonly pointerY: number
}

interface ResizeStart extends PointerStart {
  readonly height: number
  readonly width: number
}

export function WorkspacePreviewMiniPlayer({
  workspaceId,
}: {
  readonly workspaceId: string
}) {
  const rootRef = useRef<HTMLElement | null>(null)
  const dragRef = useRef<PointerStart | null>(null)
  const resizeRef = useRef<ResizeStart | null>(null)
  const [defaultLayoutVersion, setDefaultLayoutVersion] = useState('')
  const miniPlayer = usePreviewMiniPlayerStore(
    (state) => state.byWorkspaceId[workspaceId] ?? null
  )
  const previewState = usePreviewStateStore(
    (state) => state.byWorkspaceId[workspaceId] ?? emptyWorkspacePreviewState
  )
  const snapshot = miniPlayer
    ? (previewState.sessions[miniPlayer.tabId] ?? null)
    : null
  const overlay = miniPlayer
    ? (previewState.desktopByTabId[miniPlayer.tabId] ?? null)
    : null
  const runtimeTabId = miniPlayer
    ? previewRuntimeTabId(
        workspaceId,
        previewState.serverEpoch,
        miniPlayer.tabId
      )
    : null
  // The mini player lives inside a workspace frame, which a fullscreened pane
  // covers. Its browser surface is a native `<webview>` that paints above the
  // DOM regardless of stacking, so hide it while any pane is fullscreened.
  const isPaneFullscreen = useFullscreenPaneId() !== null
  const position = miniPlayer?.position ?? null
  const size = miniPlayer?.size ?? PREVIEW_MINI_PLAYER_DEFAULT_SIZE
  const tabId = miniPlayer?.tabId ?? null

  useLayoutEffect(() => {
    if (!tabId) {
      return
    }
    const clampAndMove = () => {
      const root = rootRef.current
      const parent = root?.offsetParent
      if (!(root && parent instanceof HTMLElement)) {
        return
      }
      const nextSize = clampPreviewMiniPlayerSize(
        { width: root.offsetWidth, height: root.offsetHeight },
        { width: parent.clientWidth, height: parent.clientHeight }
      )
      usePreviewMiniPlayerStore.getState().resize(workspaceId, tabId, nextSize)
      if (!position) {
        setDefaultLayoutVersion(`${parent.clientWidth}:${parent.clientHeight}`)
        return
      }
      usePreviewMiniPlayerStore
        .getState()
        .move(
          workspaceId,
          tabId,
          clampPreviewMiniPlayerPosition(
            position,
            { width: parent.clientWidth, height: parent.clientHeight },
            nextSize
          )
        )
    }
    clampAndMove()
    const root = rootRef.current
    const parent = root?.offsetParent
    if (
      !(root && parent instanceof HTMLElement) ||
      typeof ResizeObserver === 'undefined'
    ) {
      return
    }
    const observer = new ResizeObserver(clampAndMove)
    observer.observe(root)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [position, tabId, workspaceId])

  if (!(miniPlayer && snapshot && runtimeTabId)) {
    return null
  }

  const pointerStart = (
    event: ReactPointerEvent<HTMLElement>,
    includeSize: boolean
  ): PointerStart | ResizeStart | null => {
    if (event.button !== 0) {
      return null
    }
    const root = rootRef.current
    const parent = root?.offsetParent
    if (!(root && parent instanceof HTMLElement)) {
      return null
    }
    const rootRect = root.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    return {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
      ...(includeSize
        ? { width: root.offsetWidth, height: root.offsetHeight }
        : {}),
    }
  }

  const endPointer = (event: ReactPointerEvent<HTMLElement>) => {
    dragRef.current = null
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <section
      aria-label="Floating browser preview"
      className="pointer-events-none absolute z-30 select-none"
      data-preview-mini-player={miniPlayer.tabId}
      ref={rootRef}
      style={
        position
          ? {
              height: size.height,
              left: position.x,
              top: position.y,
              width: size.width,
            }
          : {
              height: size.height,
              right: PREVIEW_MINI_PLAYER_EDGE_GAP,
              top: PREVIEW_MINI_PLAYER_EDGE_GAP,
              width: size.width,
            }
      }
    >
      <div className="group pointer-events-auto absolute top-2 right-2 z-[34] size-3">
        <div
          aria-hidden="true"
          className="absolute top-0 right-0 size-2 rounded-full bg-foreground/25 shadow-sm ring-1 ring-background/70 transition-opacity group-focus-within:opacity-0 group-hover:opacity-0"
        />
        <div
          className="pointer-events-none absolute top-0 right-0 flex h-8 cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg backdrop-blur-xl transition-opacity active:cursor-grabbing group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
          onPointerCancel={endPointer}
          onPointerDown={(event) => {
            dragRef.current = pointerStart(event, false) as PointerStart | null
            if (!dragRef.current) {
              return
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            const root = rootRef.current
            const parent = root?.offsetParent
            if (
              !drag ||
              drag.pointerId !== event.pointerId ||
              !root ||
              !(parent instanceof HTMLElement)
            ) {
              return
            }
            usePreviewMiniPlayerStore.getState().move(
              workspaceId,
              miniPlayer.tabId,
              clampPreviewMiniPlayerPosition(
                {
                  x: drag.playerX + event.clientX - drag.pointerX,
                  y: drag.playerY + event.clientY - drag.pointerY,
                },
                { width: parent.clientWidth, height: parent.clientHeight },
                { width: root.offsetWidth, height: root.offsetHeight }
              )
            )
          }}
          onPointerUp={endPointer}
        >
          <MiniPlayerButton
            label="Open preview in right panel"
            onClick={() => {
              usePreviewMiniPlayerStore.getState().close(workspaceId)
              useRightPanelStore
                .getState()
                .openBrowser(workspaceId, miniPlayer.tabId)
            }}
          >
            <PanelRight />
          </MiniPlayerButton>
          <MiniPlayerButton
            disabled={!overlay?.hasWebContents}
            label={
              overlay?.pictureInPicture
                ? 'Close popped-out preview'
                : 'Pop preview into separate window'
            }
            onClick={() => {
              const pictureInPicture =
                window.desktopBridge?.preview?.pictureInPicture
              if (!pictureInPicture) {
                return
              }
              const operation = overlay?.pictureInPicture
                ? pictureInPicture.close
                : pictureInPicture.open
              operation(runtimeTabId).catch(() => undefined)
            }}
            variant={overlay?.pictureInPicture ? 'secondary' : 'ghost'}
          >
            <PictureInPicture2 />
          </MiniPlayerButton>
          <MiniPlayerButton
            label="Close floating preview"
            onClick={() =>
              usePreviewMiniPlayerStore.getState().close(workspaceId)
            }
          >
            <X />
          </MiniPlayerButton>
        </div>
      </div>
      <div className="relative h-full min-h-0">
        <div className="absolute inset-0 z-[29] rounded-xl bg-muted shadow-2xl" />
        <BrowserSurfaceSlot
          className="absolute inset-0"
          cornerRadius={12}
          fitSourceContent
          layoutVersion={
            position
              ? `${position.x}:${position.y}`
              : `initial:${defaultLayoutVersion}`
          }
          tabId={runtimeTabId}
          visible={Boolean(overlay?.hasWebContents) && !isPaneFullscreen}
        />
        <div className="pointer-events-none absolute inset-0 z-[31] rounded-xl ring-1 ring-border/80 ring-inset" />
        {overlay?.hasWebContents ? null : (
          <div className="pointer-events-none absolute inset-0 z-[32] flex items-center justify-center rounded-xl bg-muted text-muted-foreground text-xs">
            Reconnecting preview...
          </div>
        )}
        <button
          aria-label="Resize floating preview"
          className="pointer-events-auto absolute right-0 bottom-0 z-[33] size-5 cursor-nwse-resize rounded-br-xl after:absolute after:right-1 after:bottom-1 after:size-2 after:border-foreground/45 after:border-r after:border-b"
          onPointerCancel={endPointer}
          onPointerDown={(event) => {
            resizeRef.current = pointerStart(event, true) as ResizeStart | null
            if (!resizeRef.current) {
              return
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerMove={(event) => {
            const resize = resizeRef.current
            const root = rootRef.current
            const parent = root?.offsetParent
            if (
              !resize ||
              resize.pointerId !== event.pointerId ||
              !root ||
              !(parent instanceof HTMLElement)
            ) {
              return
            }
            const nextSize = clampPreviewMiniPlayerSize(
              {
                width: resize.width + event.clientX - resize.pointerX,
                height: resize.height + event.clientY - resize.pointerY,
              },
              { width: parent.clientWidth, height: parent.clientHeight }
            )
            usePreviewMiniPlayerStore
              .getState()
              .resize(workspaceId, miniPlayer.tabId, nextSize)
            usePreviewMiniPlayerStore
              .getState()
              .move(
                workspaceId,
                miniPlayer.tabId,
                clampPreviewMiniPlayerPosition(
                  { x: resize.playerX, y: resize.playerY },
                  { width: parent.clientWidth, height: parent.clientHeight },
                  nextSize
                )
              )
          }}
          onPointerUp={endPointer}
          type="button"
        />
      </div>
    </section>
  )
}

function MiniPlayerButton(props: {
  readonly children: React.ReactNode
  readonly disabled?: boolean
  readonly label: string
  readonly onClick: () => void
  readonly variant?: 'ghost' | 'secondary'
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            onPointerDown={(event) => event.stopPropagation()}
            size="icon-xs"
            type="button"
            variant={props.variant ?? 'ghost'}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent side="top">{props.label}</TooltipContent>
    </Tooltip>
  )
}
