import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerGate } from '../src/components/server-gate'

const START_COMMAND = /bun run dev/

describe('ServerGate', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('presents an unavailable daemon as starting and gates its children', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('not up yet'))

    render(
      <ServerGate>
        <div>Mission control</div>
      </ServerGate>
    )

    expect(screen.getByText('Starting daemon')).toBeTruthy()
    expect(screen.queryByText('Mission control')).toBeNull()
    expect(fetch).toHaveBeenCalledWith(
      '/health',
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it('escalates to actionable copy when the daemon never answers', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('not up yet'))

    render(
      <ServerGate>
        <div>Mission control</div>
      </ServerGate>
    )

    await vi.advanceTimersByTimeAsync(1000)
    expect(screen.getByText('Starting daemon')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(screen.getByText('Can’t reach the daemon')).toBeTruthy()
    expect(screen.getByText(START_COMMAND)).toBeTruthy()
    expect(screen.queryByText('Mission control')).toBeNull()
    vi.useRealTimers()
  })

  it('boots the app after the daemon reports healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 })
    )

    render(
      <ServerGate>
        <div>Mission control</div>
      </ServerGate>
    )

    await waitFor(() => {
      expect(screen.getByText('Mission control')).toBeTruthy()
    })
  })

  it('revives after the daemon becomes available', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('not up yet'))
      .mockResolvedValue(new Response(null, { status: 200 }))

    render(
      <ServerGate>
        <div>Mission control</div>
      </ServerGate>
    )

    await waitFor(
      () => {
        expect(screen.getByText('Mission control')).toBeTruthy()
      },
      { timeout: 2000 }
    )
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('aborts an in-flight health request when the gate unmounts', () => {
    let requestSignal: AbortSignal | undefined
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      requestSignal = init?.signal ?? undefined
      return new Promise(() => undefined)
    })

    const rendered = render(
      <ServerGate>
        <div>Mission control</div>
      </ServerGate>
    )
    rendered.unmount()

    expect(requestSignal?.aborted).toBe(true)
  })
})
