/**
 * Regression coverage for the shared sidecar status poll loop: N consumers
 * share one ref-counted poller, unchanged statuses do not notify listeners,
 * the 3-strikes crash semantics are preserved, and polling pauses while the
 * document is hidden.
 *
 * @see apps/web/src/atoms/sidecar-statuses.ts
 */

import { AtomRegistry } from 'effect/unstable/reactivity'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createSidecarHealthTracker,
  sidecarStatusesAtom,
  sidecarStatusesPollerAtom,
} from '../../src/atoms/sidecar-statuses'
import {
  areSidecarStatusesEqual,
  deriveSidecarStatuses,
  type SidecarStatuses,
} from '../../src/lib/sidecar-statuses'

const setDocumentVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

const healthyFetch = () => vi.fn(async () => new Response('', { status: 200 }))

/** Let scheduled registry tasks (node removal, subscriptions) run. */
const flushTasks = () =>
  new Promise<void>((resolve) => {
    setTimeout(() => setTimeout(resolve, 0), 0)
  })

/** Registries created per test, always disposed so no poller leaks. */
const registries: AtomRegistry.AtomRegistry[] = []
const makeRegistry = () => {
  const registry = AtomRegistry.make()
  registries.push(registry)
  return registry
}

afterEach(async () => {
  for (const registry of registries.splice(0)) {
    registry.dispose()
  }
  await flushTasks()
  vi.unstubAllGlobals()
  setDocumentVisibility('visible')
})

describe('createSidecarHealthTracker', () => {
  it('needs three consecutive failures to crash from an unknown state', () => {
    const tracker = createSidecarHealthTracker()
    expect(tracker.report('server', false)).toBeUndefined()
    expect(tracker.report('server', false)).toBeUndefined()
    expect(tracker.report('server', false)).toEqual({
      error: 'Service unreachable',
      name: 'server',
      state: 'crashed',
    })
  })

  it('crashes immediately on the first failure after being healthy', () => {
    const tracker = createSidecarHealthTracker()
    expect(tracker.report('server', true)).toEqual({
      name: 'server',
      state: 'healthy',
    })
    expect(tracker.report('server', false)).toEqual({
      error: 'Service unreachable',
      name: 'server',
      state: 'crashed',
    })
  })

  it('resets the failure count on recovery and reports healthy once', () => {
    const tracker = createSidecarHealthTracker()
    expect(tracker.report('server', false)).toBeUndefined()
    expect(tracker.report('server', false)).toBeUndefined()
    expect(tracker.report('server', true)).toEqual({
      name: 'server',
      state: 'healthy',
    })
    // Healthy again — no duplicate event.
    expect(tracker.report('server', true)).toBeUndefined()
    // A single failure after recovery crashes immediately.
    expect(tracker.report('server', false)).toEqual({
      error: 'Service unreachable',
      name: 'server',
      state: 'crashed',
    })
  })
})

describe('sidecarStatusesAtom', () => {
  it('does not notify listeners when the new statuses deep-equal the old', () => {
    const registry = makeRegistry()
    const seen: SidecarStatuses[] = []
    registry.subscribe(sidecarStatusesAtom, (value) => seen.push(value), {
      immediate: true,
    })
    expect(seen).toHaveLength(1)

    // Structurally equal to the initial value — no notification.
    registry.set(sidecarStatusesAtom, deriveSidecarStatuses([]))
    expect(seen).toHaveLength(1)

    const healthy = deriveSidecarStatuses([
      { name: 'server', state: 'healthy' },
    ])
    registry.set(sidecarStatusesAtom, healthy)
    expect(seen).toHaveLength(2)

    // A fresh but equal derivation — still no notification.
    registry.set(
      sidecarStatusesAtom,
      deriveSidecarStatuses([{ name: 'server', state: 'healthy' }])
    )
    expect(seen).toHaveLength(2)
    expect(areSidecarStatusesEqual(seen[1] as SidecarStatuses, healthy)).toBe(
      true
    )
  })
})

describe('sidecarStatusesPollerAtom', () => {
  it('shares one poll loop between two consumers', async () => {
    const fetchMock = healthyFetch()
    vi.stubGlobal('fetch', fetchMock)
    const registry = makeRegistry()

    const unmountA = registry.mount(sidecarStatusesPollerAtom)
    const unmountB = registry.mount(sidecarStatusesPollerAtom)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    // Give a would-be second loop time to fire; the count must not double.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await vi.waitFor(() =>
      expect(registry.get(sidecarStatusesAtom).server).toEqual({
        state: 'healthy',
      })
    )

    unmountA()
    unmountB()
  })

  it('stops when the last consumer unmounts and restarts on remount', async () => {
    const fetchMock = healthyFetch()
    vi.stubGlobal('fetch', fetchMock)
    const registry = makeRegistry()

    const unmountA = registry.mount(sidecarStatusesPollerAtom)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    unmountA()
    // Node removal runs on the registry's next scheduler tick.
    await flushTasks()

    // A fresh mount rebuilds the poller, which re-polls immediately.
    const unmountB = registry.mount(sidecarStatusesPollerAtom)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6))
    unmountB()
  })

  it('does not poll while the document is hidden, then polls on visible', async () => {
    setDocumentVisibility('hidden')
    const fetchMock = healthyFetch()
    vi.stubGlobal('fetch', fetchMock)
    const registry = makeRegistry()

    const unmount = registry.mount(sidecarStatusesPollerAtom)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fetchMock).not.toHaveBeenCalled()
    // The pre-poll starting state still lands so the UI is not stuck gray.
    expect(registry.get(sidecarStatusesAtom).server).toEqual({
      state: 'starting',
    })

    setDocumentVisibility('visible')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    unmount()
  })
})
