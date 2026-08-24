/**
 * Frame-aligned PTY output coalescing.
 *
 * Agent TUIs emit continuous small writes; forwarding each one costs a
 * full IPC hop, RPC parse, and renderer draw (~170 renders/sec measured).
 * This module batches raw PTY output per terminal: chunks are appended to
 * a buffer and flushed as one concatenated chunk at most once per
 * ~16ms window (one frame), collapsing the render rate to ≤60/sec.
 * VS Code's pty host performs the same batching.
 *
 * The flush timer is armed by the first unflushed chunk and is NOT
 * extended by subsequent chunks, so added latency is bounded by the
 * window (imperceptible at 16ms). A max-buffer-size safety valve flushes
 * immediately during output floods to bound memory.
 *
 * Ordering is preserved exactly: data is emitted in arrival order, valve
 * flushes are synchronous, and callers must invoke `flush()` before
 * delivering exit/close events so no bytes are lost or reordered.
 */

import { utf8Bytes } from '../services/terminal-transport.js'

/** Coalescing window — one frame at 60fps. */
const COALESCE_WINDOW_MS_DEFAULT = 16

/** Safety valve — flush immediately once this many bytes are buffered. */
const COALESCE_MAX_BUFFER_BYTES_DEFAULT = 256 * 1024

interface CoalescingDataHandler {
  /**
   * Synchronously emit any buffered data and cancel the pending timer.
   * Safe to call when the buffer is empty. Callers MUST invoke this
   * before forwarding exit events, killing the PTY, or resizing (so
   * output ordering relative to lifecycle events is preserved).
   */
  readonly flush: () => void
  /** Append a chunk. Schedules a flush or triggers the size valve. */
  readonly write: (data: string) => void
}

interface CoalescingOptions {
  readonly maxBufferBytes?: number
  /**
   * Coalescing window in milliseconds, or a getter re-read every time a
   * flush timer is armed. A getter makes the window runtime-switchable
   * (battery-saver vs performance profiles): a pending flush scheduled
   * under the old window simply completes; only subsequent scheduling
   * uses the new window, so no data is lost or reordered.
   */
  readonly windowMs?: number | (() => number)
}

/**
 * A mutable coalesce window shared by every coalescer in a pty host.
 *
 * `set` is ignored while an explicit environment override is present —
 * operators pinning `TERMINAL_OUTPUT_COALESCE_MS` always win over
 * profile switching.
 */
interface RuntimeCoalesceWindow {
  readonly get: () => number
  readonly set: (windowMs: number) => void
}

const createRuntimeCoalesceWindow = (options: {
  readonly defaultMs?: number
  readonly envOverrideMs?: number | undefined
}): RuntimeCoalesceWindow => {
  const envOverrideMs = options.envOverrideMs
  let windowMs =
    envOverrideMs ?? options.defaultMs ?? COALESCE_WINDOW_MS_DEFAULT
  return {
    get: () => windowMs,
    set: (nextWindowMs: number) => {
      if (envOverrideMs !== undefined) {
        return
      }
      if (Number.isInteger(nextWindowMs) && nextWindowMs > 0) {
        windowMs = nextWindowMs
      }
    },
  }
}

/**
 * Create a per-terminal coalescing handler.
 *
 * `onFlush` receives the concatenated buffered data exactly once per
 * flush, in arrival order, with no bytes duplicated or dropped.
 */
const createCoalescingDataHandler = (
  onFlush: (data: string) => void,
  options?: CoalescingOptions
): CoalescingDataHandler => {
  const windowOption = options?.windowMs ?? COALESCE_WINDOW_MS_DEFAULT
  const currentWindowMs =
    typeof windowOption === 'function' ? windowOption : () => windowOption
  const maxBufferBytes =
    options?.maxBufferBytes ?? COALESCE_MAX_BUFFER_BYTES_DEFAULT

  let chunks: string[] = []
  let bufferedBytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (chunks.length === 0) {
      return
    }
    const joined = chunks.join('')
    chunks = []
    bufferedBytes = 0
    onFlush(joined)
  }

  const write = (data: string): void => {
    if (data.length === 0) {
      return
    }
    chunks.push(data)
    bufferedBytes += utf8Bytes(data)

    // Size valve: bound memory during floods by flushing synchronously.
    if (bufferedBytes >= maxBufferBytes) {
      flush()
      return
    }

    // Arm the timer on the first unflushed chunk only — later chunks
    // ride the same deadline so latency stays bounded by the window.
    if (timer === undefined) {
      timer = setTimeout(flush, currentWindowMs())
    }
  }

  return { flush, write }
}

export {
  COALESCE_MAX_BUFFER_BYTES_DEFAULT,
  COALESCE_WINDOW_MS_DEFAULT,
  createCoalescingDataHandler,
  createRuntimeCoalesceWindow,
}
export type { CoalescingDataHandler, RuntimeCoalesceWindow }
