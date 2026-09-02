/**
 * Frame-aligned PTY output coalescing unit tests.
 *
 * Tests the createCoalescingDataHandler function that rate-limits raw PTY
 * output to ~16ms windows so downstream consumers (journal, headless
 * terminal, attach subscribers, renderer IPC) see at most ~60 emits/sec
 * instead of one per raw PTY chunk — while the first chunk after idle
 * still goes out immediately, so a keystroke echo is never delayed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBufferedDataHandler } from '../src/lib/buffered-data-handler.js'
import {
  createCoalescingDataHandler,
  createRuntimeCoalesceWindow,
} from '../src/lib/coalescing-data-handler.js'

describe('createCoalescingDataHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the first chunk after idle immediately (keystroke echo pays no window)', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    handler.write('j')

    expect(onFlush).toHaveBeenCalledOnce()
    expect(onFlush).toHaveBeenCalledWith('j')
  })

  it('concatenates chunks arriving within the window into one trailing emit', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    handler.write('a')
    handler.write('b')
    handler.write('c')

    expect(onFlush).toHaveBeenCalledOnce()
    expect(onFlush).toHaveBeenCalledWith('a')

    vi.advanceTimersByTime(15)
    expect(onFlush).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(1)

    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenNthCalledWith(2, 'bc')
  })

  it('anchors the window to the leading emit (later chunks do not extend the deadline)', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    handler.write('first')
    vi.advanceTimersByTime(10)
    handler.write('second')
    // 16ms after the FIRST chunk — must flush even though the second
    // chunk arrived only 6ms ago.
    vi.advanceTimersByTime(6)

    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenNthCalledWith(1, 'first')
    expect(onFlush).toHaveBeenNthCalledWith(2, 'second')
  })

  it('caps a sustained flood at one emit per window', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    // A TUI redrawing every 4ms for 160ms: 40 chunks.
    for (let index = 0; index < 40; index += 1) {
      handler.write(`${index},`)
      vi.advanceTimersByTime(4)
    }

    // Leading emit at t=0, then one trailing emit per 16ms window: 1 + 10.
    expect(onFlush).toHaveBeenCalledTimes(11)
    expect(onFlush.mock.calls.map(([data]) => data).join('')).toBe(
      Array.from({ length: 40 }, (_, index) => `${index},`).join('')
    )
  })

  it('returns to idle after a window closes with nothing buffered', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    handler.write('one')
    vi.advanceTimersByTime(16)
    // Idle again: the next chunk is a fresh leading edge.
    handler.write('two')

    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenNthCalledWith(1, 'one')
    expect(onFlush).toHaveBeenNthCalledWith(2, 'two')
  })

  it('flushes immediately when the buffer reaches the size valve', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, {
      maxBufferBytes: 8,
      windowMs: 16,
    })

    handler.write('lead')
    expect(onFlush).toHaveBeenCalledOnce()

    handler.write('1234')
    expect(onFlush).toHaveBeenCalledOnce()

    handler.write('5678')

    // 8 bytes buffered — the valve trips synchronously, no timer wait.
    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenNthCalledWith(2, '12345678')

    // The timer was cancelled by the valve flush: nothing more emits.
    vi.advanceTimersByTime(16)
    expect(onFlush).toHaveBeenCalledTimes(2)
  })

  it('measures the valve in UTF-8 bytes, not UTF-16 code units', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, {
      maxBufferBytes: 6,
      windowMs: 16,
    })

    handler.write('x')
    expect(onFlush).toHaveBeenCalledOnce()

    // Two 3-byte characters = 6 bytes (but only 2 code units).
    handler.write('\u{20AC}')
    expect(onFlush).toHaveBeenCalledOnce()
    handler.write('\u{20AC}')

    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenNthCalledWith(2, '\u{20AC}\u{20AC}')
  })

  it('flushes pending data synchronously on explicit flush (close/exit path)', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    handler.write('lead')
    handler.write('trailing output')
    handler.flush()

    expect(onFlush).toHaveBeenCalledTimes(2)
    expect(onFlush).toHaveBeenNthCalledWith(2, 'trailing output')

    // The pending timer was cancelled — no duplicate emit later.
    vi.advanceTimersByTime(16)
    expect(onFlush).toHaveBeenCalledTimes(2)
  })

  it('is a no-op to flush with an empty buffer', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    handler.flush()
    handler.write('a')
    vi.advanceTimersByTime(16)
    handler.flush()

    expect(onFlush).toHaveBeenCalledOnce()
    expect(onFlush).toHaveBeenCalledWith('a')
  })

  it('ignores empty writes without arming a timer', () => {
    const onFlush = vi.fn()
    const handler = createCoalescingDataHandler(onFlush, { windowMs: 16 })

    handler.write('')
    vi.advanceTimersByTime(16)

    expect(onFlush).not.toHaveBeenCalled()
  })

  it('preserves exact byte order across many windows', () => {
    const emitted: string[] = []
    const handler = createCoalescingDataHandler((data) => emitted.push(data), {
      windowMs: 16,
    })

    const inputs = ['alpha ', 'beta ', 'gamma ', 'delta ', 'epsilon']
    for (const input of inputs) {
      handler.write(input)
      vi.advanceTimersByTime(7)
    }
    handler.flush()

    expect(emitted.join('')).toBe(inputs.join(''))
  })

  it('composes with the escape-sequence holdback without reordering or duplicating bytes', () => {
    const emitted: string[] = []
    const coalescer = createCoalescingDataHandler(
      (data) => emitted.push(data),
      { windowMs: 16 }
    )
    // Holdback upstream of coalescing: incomplete escape sequences are
    // held back before entering the coalesce buffer, completed ones
    // ride the next window.
    const handler = createBufferedDataHandler(coalescer.write)

    // An SGR sequence split across chunk boundaries mid-parameters.
    handler('hello \x1b[3')
    vi.advanceTimersByTime(16)
    handler('1mworld\x1b[0m done')
    vi.advanceTimersByTime(16)
    coalescer.flush()

    expect(emitted.join('')).toBe('hello \x1b[31mworld\x1b[0m done')
    // The first emit carried only the complete prefix; the held-back
    // fragment arrived intact in the second.
    expect(emitted[0]).toBe('hello ')
    expect(emitted[1]).toBe('\x1b[31mworld\x1b[0m done')
  })

  it('re-reads a windowMs getter each time a window is opened', () => {
    const onFlush = vi.fn()
    let windowMs = 16
    const handler = createCoalescingDataHandler(onFlush, {
      windowMs: () => windowMs,
    })

    handler.write('lead')
    handler.write('slow')
    vi.advanceTimersByTime(16)
    expect(onFlush).toHaveBeenNthCalledWith(2, 'slow')
    // The trailing emit re-opened a window; let it close empty, going idle.
    vi.advanceTimersByTime(16)

    // Switch to the performance profile — the next opened window is 8ms.
    windowMs = 8
    handler.write('lead')
    handler.write('fast')
    vi.advanceTimersByTime(8)
    expect(onFlush).toHaveBeenNthCalledWith(4, 'fast')
  })

  it('completes a pending flush under the old window when the window changes mid-buffer, without loss or reorder', () => {
    const emitted: string[] = []
    let windowMs = 16
    const handler = createCoalescingDataHandler((data) => emitted.push(data), {
      windowMs: () => windowMs,
    })

    // Window opened under 16ms by the leading emit.
    handler.write('lead ')
    handler.write('before ')
    vi.advanceTimersByTime(4)

    // Profile switch mid-buffer: the pending flush keeps its original
    // 16ms deadline; buffered and subsequent chunks stay in order.
    windowMs = 8
    handler.write('after')

    vi.advanceTimersByTime(7)
    expect(emitted).toEqual(['lead '])

    vi.advanceTimersByTime(5)
    expect(emitted).toEqual(['lead ', 'before after'])

    // That trailing emit re-opened a window under the new 8ms.
    handler.write('next')
    vi.advanceTimersByTime(7)
    expect(emitted).toEqual(['lead ', 'before after'])
    vi.advanceTimersByTime(1)
    expect(emitted).toEqual(['lead ', 'before after', 'next'])
  })

  it('keeps a held-back escape fragment out of a valve flush', () => {
    const emitted: string[] = []
    const coalescer = createCoalescingDataHandler(
      (data) => emitted.push(data),
      { maxBufferBytes: 4, windowMs: 16 }
    )
    const handler = createBufferedDataHandler(coalescer.write)

    handler('x')
    expect(emitted).toEqual(['x'])

    // 4 complete bytes trip the valve; the bare ESC stays held back
    // upstream and is never emitted in partial form.
    handler('abcd\x1b')

    expect(emitted).toEqual(['x', 'abcd'])

    // Completing the sequence later delivers it whole and in order.
    handler('[2K')
    vi.advanceTimersByTime(16)

    expect(emitted.join('')).toBe('xabcd\x1b[2K')
  })
})

describe('createRuntimeCoalesceWindow', () => {
  it('starts at the default and applies runtime changes', () => {
    const window = createRuntimeCoalesceWindow({ defaultMs: 16 })

    expect(window.get()).toBe(16)
    window.set(8)
    expect(window.get()).toBe(8)
  })

  it('ignores runtime changes while an env override is present', () => {
    const window = createRuntimeCoalesceWindow({
      defaultMs: 16,
      envOverrideMs: 4,
    })

    expect(window.get()).toBe(4)
    window.set(8)
    expect(window.get()).toBe(4)
  })

  it('rejects non-positive and non-integer runtime values', () => {
    const window = createRuntimeCoalesceWindow({ defaultMs: 16 })

    window.set(0)
    window.set(-5)
    window.set(2.5)
    window.set(Number.NaN)

    expect(window.get()).toBe(16)
  })
})
