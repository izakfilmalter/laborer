import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServerGate } from '../src/components/server-gate'

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

  it('boots the app after the daemon reports healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response)

    render(
      <ServerGate>
        <div>Mission control</div>
      </ServerGate>
    )

    await waitFor(() => {
      expect(screen.getByText('Mission control')).toBeTruthy()
    })
  })
})
