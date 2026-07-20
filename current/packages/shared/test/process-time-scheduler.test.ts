/**
 * Tests for the process-time (awake-time) scheduler.
 *
 * Uses fake timers — advancing fake time runs the interval callbacks,
 * which models awake time. Sleep is modeled by NOT advancing timers
 * (interval callbacks simply don't run while the OS sleeps, so there is
 * nothing to simulate beyond not running them).
 *
 * @see packages/shared/src/process-time-scheduler.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { scheduleProcessTimeTimeout } from '../src/process-time-scheduler.js'

describe('scheduleProcessTimeTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires after the scheduled awake time', () => {
    const runner = vi.fn()
    scheduleProcessTimeTimeout(runner, 5000)

    vi.advanceTimersByTime(4000)
    expect(runner).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1000)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('fires exactly once', () => {
    const runner = vi.fn()
    scheduleProcessTimeTimeout(runner, 2000)

    vi.advanceTimersByTime(10_000)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('does not fire after cancel', () => {
    const runner = vi.fn()
    const handle = scheduleProcessTimeTimeout(runner, 3000)

    vi.advanceTimersByTime(2000)
    handle.cancel()
    vi.advanceTimersByTime(10_000)

    expect(runner).not.toHaveBeenCalled()
  })

  it('reports scheduled state', () => {
    const runner = vi.fn()
    const handle = scheduleProcessTimeTimeout(runner, 2000)

    expect(handle.isScheduled()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(handle.isScheduled()).toBe(false)
  })

  it('reports unscheduled after cancel', () => {
    const handle = scheduleProcessTimeTimeout(vi.fn(), 2000)
    handle.cancel()
    expect(handle.isScheduled()).toBe(false)
  })

  it('rounds sub-second delays up to one tick', () => {
    const runner = vi.fn()
    scheduleProcessTimeTimeout(runner, 1)

    vi.advanceTimersByTime(999)
    expect(runner).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('cancel is idempotent', () => {
    const handle = scheduleProcessTimeTimeout(vi.fn(), 2000)
    handle.cancel()
    handle.cancel()
    expect(handle.isScheduled()).toBe(false)
  })
})
