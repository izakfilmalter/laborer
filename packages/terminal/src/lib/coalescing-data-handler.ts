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
  readonly windowMs?: number
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
  const windowMs = options?.windowMs ?? COALESCE_WINDOW_MS_DEFAULT
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
      timer = setTimeout(flush, windowMs)
    }
  }

  return { flush, write }
}

export {
  COALESCE_MAX_BUFFER_BYTES_DEFAULT,
  COALESCE_WINDOW_MS_DEFAULT,
  createCoalescingDataHandler,
}
export type { CoalescingDataHandler }
