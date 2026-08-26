import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { diffViewCollection } from '@/db/local-preferences'
import { useDiffViewPreference } from '@/hooks/use-diff-view-preference'

const forget = async (id: string): Promise<void> => {
  if (diffViewCollection.has(id)) {
    await diffViewCollection.delete(id).isPersisted.promise
  }
}

describe('the diff pane view preference', () => {
  afterEach(() => cleanup())

  it('starts on the uncommitted diff with whitespace included', async () => {
    await forget('ws-default')

    const { result } = renderHook(() => useDiffViewPreference('ws-default'))

    expect(result.current.target).toEqual({ _tag: 'working' })
    expect(result.current.ignoreWhitespace).toBe(false)
  })

  it('survives the pane closing and reopening', async () => {
    await forget('ws-reopen')

    const first = renderHook(() => useDiffViewPreference('ws-reopen'))
    act(() => first.result.current.setTarget({ _tag: 'branch' }))
    await waitFor(() =>
      expect(first.result.current.target).toEqual({ _tag: 'branch' })
    )
    first.unmount()

    const reopened = renderHook(() => useDiffViewPreference('ws-reopen'))
    expect(reopened.result.current.target).toEqual({ _tag: 'branch' })
  })

  it('round-trips a typed ref, not just the two named targets', async () => {
    await forget('ws-ref')

    const { result, unmount } = renderHook(() =>
      useDiffViewPreference('ws-ref')
    )
    act(() =>
      result.current.setTarget({ _tag: 'ref', ref: 'origin/release-2026' })
    )
    await waitFor(() =>
      expect(result.current.target).toEqual({
        _tag: 'ref',
        ref: 'origin/release-2026',
      })
    )
    unmount()

    expect(
      renderHook(() => useDiffViewPreference('ws-ref')).result.current.target
    ).toEqual({ _tag: 'ref', ref: 'origin/release-2026' })
  })

  it('keeps the target when only the whitespace flag changes', async () => {
    await forget('ws-whitespace')

    const { result } = renderHook(() => useDiffViewPreference('ws-whitespace'))
    act(() => result.current.setTarget({ _tag: 'branch' }))
    await waitFor(() =>
      expect(result.current.target).toEqual({ _tag: 'branch' })
    )

    act(() => result.current.setIgnoreWhitespace(true))
    await waitFor(() => expect(result.current.ignoreWhitespace).toBe(true))
    expect(result.current.target).toEqual({ _tag: 'branch' })
  })

  it('is per workspace, so one pane cannot answer for another', async () => {
    await forget('ws-a')
    await forget('ws-b')

    const a = renderHook(() => useDiffViewPreference('ws-a'))
    const b = renderHook(() => useDiffViewPreference('ws-b'))

    act(() => a.result.current.setTarget({ _tag: 'branch' }))
    await waitFor(() =>
      expect(a.result.current.target).toEqual({ _tag: 'branch' })
    )

    expect(b.result.current.target).toEqual({ _tag: 'working' })
  })

  it('falls back to the default when the stored key is unreadable', async () => {
    await forget('ws-corrupt')
    await diffViewCollection.insert({
      id: 'ws-corrupt',
      ignoreWhitespace: true,
      targetKey: 'staged',
    }).isPersisted.promise

    const { result } = renderHook(() => useDiffViewPreference('ws-corrupt'))

    expect(result.current.target).toEqual({ _tag: 'working' })
    // The flag beside it is still readable, so it is still honoured.
    expect(result.current.ignoreWhitespace).toBe(true)
  })
})
