/**
 * Ported from t3code's `fileSaveCoordinator.test.ts`: debounce collapsing,
 * pending state across overlapping writes, and failed-save stickiness.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FileSaveCoordinator,
  type FileSaveOutcome,
} from '@/components/files/file-save-coordinator'

const success: FileSaveOutcome = { _tag: 'Success' }
const failure: FileSaveOutcome = { _tag: 'Failure' }

function deferred() {
  let resolve!: (result: FileSaveOutcome) => void
  const promise = new Promise<FileSaveOutcome>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('FileSaveCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces edits and persists only the latest contents', async () => {
    vi.useFakeTimers()
    const persist = vi
      .fn<(contents: string) => Promise<FileSaveOutcome>>()
      .mockResolvedValue(success)
    const onPendingChange = vi.fn()
    const onConfirmed = vi.fn()
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed,
    })

    coordinator.change('first')
    await vi.advanceTimersByTimeAsync(300)
    coordinator.change('latest')
    await vi.advanceTimersByTimeAsync(499)
    expect(persist).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(persist).toHaveBeenCalledOnce()
    expect(persist).toHaveBeenCalledWith('latest')
    expect(onConfirmed).toHaveBeenCalledWith('latest')
    expect(onPendingChange.mock.calls).toEqual([[true], [true], [false]])
  })

  it('keeps pending state until an edit made during a write is also saved', async () => {
    vi.useFakeTimers()
    const firstWrite = deferred()
    const persist = vi
      .fn<(contents: string) => Promise<FileSaveOutcome>>()
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(success)
    const onPendingChange = vi.fn()
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist,
      onPendingChange,
      onConfirmed: vi.fn(),
    })

    coordinator.change('first')
    await vi.advanceTimersByTimeAsync(500)
    coordinator.change('latest')
    await vi.advanceTimersByTimeAsync(500)
    expect(persist).toHaveBeenCalledTimes(1)

    firstWrite.resolve(success)
    await vi.runAllTimersAsync()
    expect(persist).toHaveBeenCalledTimes(2)
    expect(persist).toHaveBeenLastCalledWith('latest')
    expect(onPendingChange.mock.calls.at(-1)).toEqual([false])
  })

  it('leaves the file pending when the latest write fails', async () => {
    vi.useFakeTimers()
    const onPendingChange = vi.fn()
    const coordinator = new FileSaveCoordinator({
      debounceMs: 500,
      persist: vi.fn().mockResolvedValue(failure),
      onPendingChange,
      onConfirmed: vi.fn(),
    })

    coordinator.change('latest')
    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve()
    expect(onPendingChange).toHaveBeenCalledWith(true)
    expect(onPendingChange).not.toHaveBeenCalledWith(false)
  })
})
