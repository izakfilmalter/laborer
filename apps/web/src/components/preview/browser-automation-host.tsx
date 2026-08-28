import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import type {
  BrowserControlEvent,
  BrowserControlRequest,
  BrowserControlResponse,
} from '@laborer/shared/browser-control'
import type { DesktopPreviewBridge } from '@laborer/shared/desktop-bridge'
import { AsyncResult, Atom } from 'effect/unstable/reactivity'
import { useEffect, useRef, useState } from 'react'
import { BrowserDaemonClient } from '@/atoms/browser-daemon-client'
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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Browser automation failed'

export async function runBrowserAutomation(
  request: BrowserControlRequest,
  target: {
    readonly preview: DesktopPreviewBridge
    readonly runtimeTabId: string | null
    readonly serverTabId: string | null
  }
): Promise<unknown> {
  const { preview, runtimeTabId, serverTabId } = target
  if (request.operation === 'status') {
    return runtimeTabId
      ? {
          ...(await preview.automation.status(runtimeTabId)),
          tabId: serverTabId,
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
  if (!(runtimeTabId && serverTabId)) {
    throw new Error('No active browser tab was found')
  }
  switch (request.operation) {
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
    default:
      return request.operation satisfies never
  }
}

async function handleBrowserRequest(input: {
  readonly clientId: string
  readonly event: Extract<BrowserControlEvent, { readonly type: 'request' }>
  readonly preview: DesktopPreviewBridge | undefined
  readonly respond: (input: {
    readonly payload: BrowserControlResponse
  }) => Promise<unknown>
  readonly workspaceId: string
}) {
  const { clientId, event, preview, respond, workspaceId } = input
  const request = event.request
  const state = usePreviewStateStore.getState().byWorkspaceId[workspaceId]
  const fallback = Object.values(state?.sessions ?? {}).toSorted(
    (left, right) => right.updatedAt.localeCompare(left.updatedAt)
  )[0]
  const targetTabId = request.tabId ?? state?.activeTabId ?? fallback?.tabId
  const snapshot = targetTabId ? state?.sessions[targetTabId] : undefined
  const serverTabId = snapshot?.tabId ?? null
  const runtimeTabId =
    serverTabId && state
      ? previewRuntimeTabId(workspaceId, state.serverEpoch, serverTabId)
      : null
  if (serverTabId && state?.desktopByTabId[serverTabId]) {
    usePreviewStateStore
      .getState()
      .setController(workspaceId, serverTabId, 'agent')
  }
  let response: BrowserControlResponse
  try {
    const result = preview
      ? await runBrowserAutomation(request, {
          preview,
          runtimeTabId,
          serverTabId,
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
  const connectionId = useRef<string | null>(null)
  const handled = useRef(new Set<string>())

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
      handleBrowserRequest({
        clientId,
        event,
        preview,
        respond,
        workspaceId: props.workspaceId,
      }).catch(() => undefined)
    }
  }, [clientId, props.workspaceId, respond, result])

  return null
}
