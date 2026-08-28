import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import type {
  BrowserControlEvent,
  BrowserControlNavigateInput,
  BrowserControlOpenInput,
  BrowserControlRequest,
  BrowserControlResizeInput,
  BrowserControlResponse,
} from '@laborer/shared/browser-control'
import type { DesktopPreviewBridge } from '@laborer/shared/desktop-bridge'
import type {
  PreviewSessionSnapshot,
  PreviewViewportSetting,
} from '@laborer/shared/rpc'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'
import { useEffect, useRef, useState } from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
import {
  startBrowserRecording,
  stopBrowserRecording,
} from '@/browser/browser-recording'
import { usePreviewMiniPlayerStore } from '@/preview-mini-player-store'
import {
  previewRuntimeTabId,
  usePreviewStateStore,
} from '@/preview-state-store'

const requestsAtom = Atom.family((key: string) => {
  const input = JSON.parse(key) as {
    readonly clientId: string
    readonly workspaceId: string
  }
  return BrowserDaemonClient.query('browserControl.connect', input)
})
const respondMutation = BrowserDaemonClient.mutation('browserControl.respond')
const openMutation = BrowserDaemonClient.mutation('preview.open')
const navigateMutation = BrowserDaemonClient.mutation('preview.navigate')
const resizeMutation = BrowserDaemonClient.mutation('preview.resize')

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Browser automation failed'

export const enqueueBrowserRequest = <A,>(
  current: Promise<unknown>,
  task: () => Promise<A>
): Promise<A> => current.then(task)

const PRESETS = {
  'iphone-se': [375, 667],
  'iphone-xr': [414, 896],
  'iphone-12-pro': [390, 844],
  'iphone-14-pro-max': [430, 932],
  'pixel-7': [412, 915],
  'samsung-galaxy-s8-plus': [360, 740],
  'samsung-galaxy-s20-ultra': [412, 915],
  'ipad-mini': [768, 1024],
  'ipad-air': [820, 1180],
  'ipad-pro': [1024, 1366],
  'surface-pro-7': [912, 1368],
  'surface-duo': [540, 720],
  'galaxy-z-fold-5': [344, 882],
  'asus-zenbook-fold': [853, 1280],
  'samsung-galaxy-a51-71': [412, 914],
  'nest-hub': [1024, 600],
  'nest-hub-max': [1280, 800],
} as const

const resolveViewport = (
  input: BrowserControlResizeInput
): PreviewViewportSetting => {
  if (input.mode === 'fill') {
    return { _tag: 'fill' }
  }
  if (input.mode === 'freeform') {
    if (!(input.width && input.height)) {
      throw new Error('Freeform viewport requires width and height')
    }
    return { _tag: 'freeform', width: input.width, height: input.height }
  }
  if (!input.preset) {
    throw new Error('Preset viewport requires a preset')
  }
  let [width, height]: [number, number] = [...PRESETS[input.preset]]
  const nativePortrait = height >= width
  if (
    (input.orientation === 'landscape' && nativePortrait) ||
    (input.orientation === 'portrait' && !nativePortrait)
  ) {
    ;[width, height] = [height, width]
  }
  return { _tag: 'preset', presetId: input.preset, width, height }
}

interface AutomationTabTarget {
  readonly runtimeTabId: string | null
  readonly serverTabId: string | null
  readonly viewportSetting?: PreviewViewportSetting
}

interface BrowserAutomationTarget extends AutomationTabTarget {
  readonly navigate?: (input: {
    readonly workspaceId: string
    readonly tabId: string
    readonly url: string
  }) => Promise<PreviewSessionSnapshot>
  readonly open?: (input: {
    readonly workspaceId: string
    readonly url?: string
  }) => Promise<PreviewSessionSnapshot>
  readonly preview: DesktopPreviewBridge
  readonly resize?: (input: {
    readonly workspaceId: string
    readonly tabId: string
    readonly viewport: PreviewViewportSetting
  }) => Promise<PreviewSessionSnapshot>
  readonly resolveTarget?: () => AutomationTabTarget
  readonly reveal?: (tabId: string) => void
  readonly upsert?: (snapshot: PreviewSessionSnapshot) => void
  readonly workspaceId?: string
}

const waitFor = async <A,>(
  read: () => Promise<A>,
  ready: (value: A) => boolean,
  timeoutMs: number,
  message: string
): Promise<A> => {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() <= deadline) {
    try {
      const value = await read()
      if (ready(value)) {
        return value
      }
    } catch (error) {
      lastError = error
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(
    lastError ? `${message}: ${errorMessage(lastError)}` : message
  )
}

// Operation routing stays centralized so target resolution and readiness rules
// are identical for every renderer request.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: protocol dispatch is clearer as one exhaustive operation switch.
export async function runBrowserAutomation(
  request: BrowserControlRequest,
  target: BrowserAutomationTarget
): Promise<unknown> {
  const { preview } = target
  const resolveTarget = () => target.resolveTarget?.() ?? target
  let { runtimeTabId, serverTabId } = resolveTarget()
  const status = async () => {
    const current = resolveTarget()
    return current.runtimeTabId
      ? {
          ...(await preview.automation.status(current.runtimeTabId)),
          tabId: current.serverTabId,
          ...(current.viewportSetting === undefined
            ? {}
            : { viewportSetting: current.viewportSetting }),
        }
      : {
          available: true,
          visible: false,
          loading: false,
          tabId: null,
          title: null,
          url: null,
        }
  }
  if (request.operation === 'status') {
    return status()
  }
  if (request.operation === 'open') {
    const input = request.input as BrowserControlOpenInput
    if (!(target.workspaceId && target.open && target.upsert)) {
      throw new Error('Browser session creation is unavailable')
    }
    if (input.reuseExistingTab === false) {
      serverTabId = null
      runtimeTabId = null
    }
    if (request.tabId && !serverTabId) {
      throw new Error(`Browser tab ${request.tabId} was not found`)
    }
    if (!serverTabId) {
      const snapshot = await target.open({
        workspaceId: target.workspaceId,
        ...(input.url ? { url: input.url } : {}),
      })
      target.upsert(snapshot)
      serverTabId = snapshot.tabId
    } else if (input.url) {
      if (!target.navigate) {
        throw new Error('Browser navigation is unavailable')
      }
      const snapshot = await target.navigate({
        workspaceId: target.workspaceId,
        tabId: serverTabId,
        url: input.url,
      })
      target.upsert(snapshot)
      const current = resolveTarget()
      if (!current.runtimeTabId) {
        throw new Error('Browser desktop tab is unavailable')
      }
      await preview.navigate(current.runtimeTabId, input.url)
    }
    if (input.open !== false && serverTabId) {
      target.reveal?.(serverTabId)
    }
    return waitFor(
      status,
      (value) => value.available && value.tabId === serverTabId,
      request.timeoutMs,
      'Browser tab did not become ready'
    )
  }
  ;({ runtimeTabId, serverTabId } = resolveTarget())
  if (!(runtimeTabId && serverTabId)) {
    throw new Error('No active browser tab was found')
  }
  switch (request.operation) {
    case 'navigate': {
      const input = request.input as BrowserControlNavigateInput
      if (!(target.workspaceId && target.navigate && target.upsert)) {
        throw new Error('Browser navigation is unavailable')
      }
      const snapshot = await target.navigate({
        workspaceId: target.workspaceId,
        tabId: serverTabId,
        url: input.url,
      })
      target.upsert(snapshot)
      await preview.navigate(runtimeTabId, input.url)
      if (input.readiness !== 'none') {
        await waitFor(
          async () => {
            const current = await preview.automation.status(runtimeTabId)
            if (input.readiness === 'domContentLoaded') {
              const readyState = await preview.automation.evaluate(
                runtimeTabId,
                {
                  expression: 'document.readyState',
                }
              )
              return { current, readyState }
            }
            return { current, readyState: null }
          },
          ({ current, readyState }) =>
            input.readiness === 'domContentLoaded'
              ? readyState === 'interactive' || readyState === 'complete'
              : !current.loading,
          input.timeoutMs ?? request.timeoutMs,
          'Browser navigation readiness timed out'
        )
      }
      return status()
    }
    case 'resize': {
      const input = request.input as BrowserControlResizeInput
      if (!(target.workspaceId && target.resize && target.upsert)) {
        throw new Error('Browser resize is unavailable')
      }
      const setting = resolveViewport(input)
      const snapshot = await target.resize({
        workspaceId: target.workspaceId,
        tabId: serverTabId,
        viewport: setting,
      })
      target.upsert(snapshot)
      const measured = await waitFor(
        () => preview.automation.status(runtimeTabId),
        ({ viewport }) =>
          viewport !== undefined &&
          (setting._tag === 'fill' ||
            (viewport.width === setting.width &&
              viewport.height === setting.height)),
        input.timeoutMs ?? request.timeoutMs,
        'Browser viewport did not become ready'
      )
      return { tabId: serverTabId, setting, viewport: measured.viewport }
    }
    case 'snapshot':
      return preview.automation.snapshot(runtimeTabId)
    case 'click':
      await preview.automation.click(
        runtimeTabId,
        request.input as Parameters<typeof preview.automation.click>[1]
      )
      return {}
    case 'type':
      await preview.automation.type(
        runtimeTabId,
        request.input as Parameters<typeof preview.automation.type>[1]
      )
      return {}
    case 'press':
      await preview.automation.press(
        runtimeTabId,
        request.input as Parameters<typeof preview.automation.press>[1]
      )
      return {}
    case 'scroll':
      await preview.automation.scroll(
        runtimeTabId,
        request.input as Parameters<typeof preview.automation.scroll>[1]
      )
      return {}
    case 'evaluate':
      return preview.automation.evaluate(
        runtimeTabId,
        request.input as Parameters<typeof preview.automation.evaluate>[1]
      )
    case 'waitFor':
      await preview.automation.waitFor(
        runtimeTabId,
        request.input as Parameters<typeof preview.automation.waitFor>[1]
      )
      return {}
    case 'recordingStart': {
      const startedAt = await startBrowserRecording(runtimeTabId)
      return { tabId: serverTabId, recording: true, startedAt }
    }
    case 'recordingStop': {
      const artifact = await stopBrowserRecording(runtimeTabId)
      if (!artifact) {
        throw new Error(
          `No active browser recording was found for ${serverTabId}`
        )
      }
      return { ...artifact, tabId: serverTabId }
    }
    default:
      return request.operation satisfies never
  }
}

async function handleBrowserRequest(input: {
  readonly clientId: string
  readonly event: Extract<BrowserControlEvent, { readonly type: 'request' }>
  readonly preview: DesktopPreviewBridge | undefined
  readonly open: (input: {
    readonly payload: { readonly workspaceId: string; readonly url?: string }
  }) => Promise<PreviewSessionSnapshot>
  readonly navigate: (input: {
    readonly payload: {
      readonly workspaceId: string
      readonly tabId: string
      readonly url: string
    }
  }) => Promise<PreviewSessionSnapshot>
  readonly resize: (input: {
    readonly payload: {
      readonly workspaceId: string
      readonly tabId: string
      readonly viewport: PreviewViewportSetting
    }
  }) => Promise<PreviewSessionSnapshot>
  readonly respond: (input: {
    readonly payload: BrowserControlResponse
  }) => Promise<unknown>
  readonly workspaceId: string
}) {
  const {
    clientId,
    event,
    navigate,
    open,
    preview,
    resize,
    respond,
    workspaceId,
  } = input
  const request = event.request
  const resolveTarget = (): AutomationTabTarget => {
    const state = usePreviewStateStore.getState().byWorkspaceId[workspaceId]
    const fallback = Object.values(state?.sessions ?? {}).toSorted(
      (left, right) => right.updatedAt.localeCompare(left.updatedAt)
    )[0]
    const targetTabId = request.tabId ?? state?.activeTabId ?? fallback?.tabId
    const snapshot = targetTabId ? state?.sessions[targetTabId] : undefined
    const serverTabId = snapshot?.tabId ?? null
    return {
      serverTabId,
      ...(snapshot?.viewport === undefined
        ? {}
        : { viewportSetting: snapshot.viewport }),
      runtimeTabId:
        serverTabId && state
          ? previewRuntimeTabId(workspaceId, state.serverEpoch, serverTabId)
          : null,
    }
  }
  const { serverTabId } = resolveTarget()
  const initialState =
    usePreviewStateStore.getState().byWorkspaceId[workspaceId]
  if (serverTabId && initialState?.desktopByTabId[serverTabId]) {
    usePreviewStateStore
      .getState()
      .setController(workspaceId, serverTabId, 'agent')
  }
  let response: BrowserControlResponse
  try {
    const result = preview
      ? await runBrowserAutomation(request, {
          preview,
          ...resolveTarget(),
          workspaceId,
          resolveTarget,
          open: (payload) => open({ payload }),
          navigate: (payload) => navigate({ payload }),
          resize: (payload) => resize({ payload }),
          upsert: (snapshot) =>
            usePreviewStateStore.getState().upsert(workspaceId, snapshot),
          reveal: (tabId) =>
            usePreviewMiniPlayerStore.getState().open(workspaceId, tabId),
        })
      : await Promise.reject(
          new Error('Desktop browser automation is unavailable')
        )
    response = {
      clientId,
      connectionId: event.connectionId,
      requestId: request.requestId,
      status: 'result',
      result,
    }
  } catch (error) {
    response = {
      clientId,
      connectionId: event.connectionId,
      requestId: request.requestId,
      status: 'failed',
      error: {
        tag: error instanceof Error ? error.name : 'Error',
        message: errorMessage(error),
      },
    }
  } finally {
    if (serverTabId) {
      const latest =
        usePreviewStateStore.getState().byWorkspaceId[workspaceId]
          ?.desktopByTabId[serverTabId]
      if (latest?.controller === 'agent') {
        usePreviewStateStore
          .getState()
          .setController(workspaceId, serverTabId, 'none')
      }
    }
  }
  await respond({ payload: response })
}

export function BrowserAutomationHost(props: { readonly workspaceId: string }) {
  const [clientId] = useState(() => `renderer-${crypto.randomUUID()}`)
  const result = useAtomValue(
    requestsAtom(JSON.stringify({ clientId, workspaceId: props.workspaceId }))
  )
  const respond = useAtomSet(respondMutation, { mode: 'promise' })
  const open = useAtomSet(openMutation, { mode: 'promise' })
  const navigate = useAtomSet(navigateMutation, { mode: 'promise' })
  const resize = useAtomSet(resizeMutation, { mode: 'promise' })
  const connectionId = useRef<string | null>(null)
  const handled = useRef(new Set<string>())
  const queue = useRef(Promise.resolve())

  useEffect(() => {
    if (!AsyncResult.isSuccess(result)) {
      return
    }
    const connected = result.value.items.findLast(
      (event) => event.type === 'connected'
    )
    if (connected && connected.connectionId !== connectionId.current) {
      connectionId.current = connected.connectionId
      handled.current.clear()
    }
    const preview = window.desktopBridge?.preview
    for (const event of result.value.items) {
      if (
        event.type !== 'request' ||
        event.connectionId !== connectionId.current ||
        handled.current.has(event.request.requestId)
      ) {
        continue
      }
      handled.current.add(event.request.requestId)
      queue.current = enqueueBrowserRequest(queue.current, () =>
        handleBrowserRequest({
          clientId,
          event,
          navigate,
          open,
          preview,
          resize,
          respond,
          workspaceId: props.workspaceId,
        })
      ).catch(() => undefined)
    }
  }, [clientId, navigate, open, props.workspaceId, resize, respond, result])

  return null
}
