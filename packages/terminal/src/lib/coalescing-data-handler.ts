/**
 * Frame-aligned PTY output coalescing.
 *
 * Agent TUIs emit continuous small writes; forwarding each one costs a
 * full IPC hop, RPC parse, and renderer draw (~170 renders/sec measured).
 * This module rate-limits background PTY output per terminal to one emit
 * per ~16ms window (one frame), collapsing the render rate to ≤60/sec.
 * VS Code's pty host performs the same batching.
 *
 * The limiter is leading-edge: a chunk arriving while the terminal is
 * idle is emitted immediately, so an interactive keystroke echo pays no
 * added latency. Chunks arriving inside the window that follows are
 * buffered and emitted together when it closes, which re-arms the window
 * so a sustained flood stays at one emit per window. A max-buffer-size
 * safety valve flushes immediately during output floods to bound memory.
 * Input temporarily shortens this window to 1ms: an active TUI is never
 * idle, so leading-edge delivery alone still delays its keystroke echoes.
 *
 * Ordering is preserved exactly: data is emitted in arrival order, valve
 * flushes are synchronous, and callers must invoke `flush()` before
 * delivering exit/close events so no bytes are lost or reordered.
 */

import { utf8Bytes } from '../services/terminal-transport.js'

/** Coalescing window — one frame at 60fps. */
const COALESCE_WINDOW_MS_DEFAULT = 16
const INPUT_COALESCE_WINDOW_MS = 1
const INPUT_PRIORITY_DURATION_MS = 100

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
  /** Prioritize output briefly after a PTY input write, including pending output. */
  readonly onInput: () => void
  /** Append a chunk. Schedules a flush or triggers the size valve. */
  readonly write: (data: string) => void
}

interface CoalescingOptions {
  readonly maxBufferBytes?: number
  /** Disable input priority when an operator explicitly pins the output window. */
  readonly prioritizeInput?: boolean
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
  const configuredWindowMs =
    typeof windowOption === 'function' ? windowOption : () => windowOption
  let inputPriorityUntil = 0
  const currentWindowMs = (): number =>
    performance.now() < inputPriorityUntil
      ? Math.min(INPUT_COALESCE_WINDOW_MS, configuredWindowMs())
      : configuredWindowMs()
  const maxBufferBytes =
    options?.maxBufferBytes ?? COALESCE_MAX_BUFFER_BYTES_DEFAULT

  let chunks: string[] = []
  let bufferedBytes = 0
  /** Armed while a window is open; `undefined` means the terminal is idle. */
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushAt = 0

  const emit = (): void => {
    if (chunks.length === 0) {
      return
    }
    const joined = chunks.join('')
    chunks = []
    bufferedBytes = 0
    onFlush(joined)
  }

  const openWindow = (): void => {
    const windowMs = currentWindowMs()
    flushAt = performance.now() + windowMs
    timer = setTimeout(() => {
      timer = undefined
      // Output that arrived inside the window goes out now, and starts
      // another window so a flood stays at one emit per window rather
      // than doubling up on the next leading edge.
      if (chunks.length > 0) {
        emit()
        openWindow()
      }
    }, windowMs)
  }

  const onInput = (): void => {
    if (options?.prioritizeInput === false) {
      return
    }
    const now = performance.now()
    inputPriorityUntil = now + INPUT_PRIORITY_DURATION_MS
    // Shorten an existing background window, but never debounce an earlier
    // deadline when several input writes arrive together.
    if (timer !== undefined && now + currentWindowMs() < flushAt) {
      clearTimeout(timer)
      openWindow()
    }
  }

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    emit()
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

    // Idle: emit at once and open a window. Inside a window: wait for it.
    if (timer === undefined) {
      emit()
      openWindow()
    }
  }

  return { flush, onInput, write }
}

export {
  COALESCE_MAX_BUFFER_BYTES_DEFAULT,
  COALESCE_WINDOW_MS_DEFAULT,
  createCoalescingDataHandler,
  createRuntimeCoalesceWindow,
}
export type { CoalescingDataHandler, RuntimeCoalesceWindow }
