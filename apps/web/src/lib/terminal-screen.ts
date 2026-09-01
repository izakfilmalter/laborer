/**
 * The screen a terminal pane draws on, and the identity of that screen.
 *
 * A pane's surface and its attach stream have independent lifetimes. React
 * rebuilds the surface when the pane adopts a different terminal, and again
 * when StrictMode double-invokes the mount, while the daemon connection is
 * untouched; the daemon drops and restores the stream while the same surface
 * stays mounted. Anything derived from what has been *drawn* therefore belongs
 * to the surface rather than to the pane that hosts it.
 *
 * Each mounted surface is given a generation so a resume cursor can name the
 * screen it describes. A rebuilt surface is blank: resuming from the cursor the
 * previous one reached would ask the daemon to continue a screen nobody can
 * see, leaving the operator with deltas and no history underneath them.
 * Generation `0` means no surface is mounted at all — Ghostty's surface is
 * built asynchronously, so that is also the state a freshly rendered pane is in
 * while the WASM module and its fonts load.
 *
 * Ghostty parses synchronously: `write` has finished by the time it returns.
 * The screen therefore reports only whether a surface *took* a chunk, and has
 * no deferred commit to carry — the caller learns everything it needs from the
 * return value.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts — attaches against a generation
 * @see apps/web/src/panes/terminal-pane.tsx — mounts the Ghostty surface
 */

/** The slice of `GhosttyTerminalSurface` a screen draws through. */
export interface TerminalScreenCanvas {
  /**
   * RIS the terminal, then replay `data` with the PTY writer detached. This is
   * how a snapshot lands: the payload is the serialized screen, so it describes
   * the state to be *in* rather than output to append.
   */
  readonly resetAndWrite: (data: string) => void
  /** Parse live output. Synchronous — parsed once it returns. */
  readonly write: (data: string) => void
}

export interface TerminalScreen {
  /** Identifies the mounted surface; `0` while none is mounted. */
  readonly generation: () => number
  /** Adopt a freshly built, blank surface. */
  readonly mount: (canvas: TerminalScreenCanvas) => void
  /**
   * Replace the screen with `data`. Reports whether a surface took it, on the
   * same terms as `write`.
   */
  readonly resetAndWrite: (data: string) => boolean
  /** Observe surface replacement. Listeners read `generation` for the new one. */
  readonly subscribe: (listener: () => void) => () => void
  /** Retire a surface. A stale cleanup cannot retire the one that replaced it. */
  readonly unmount: (canvas: TerminalScreenCanvas) => void
  /**
   * Draw a chunk.
   *
   * Reports whether a surface took the chunk. A screen with nothing mounted
   * drops it, and a dropped chunk was never drawn: the caller must not count
   * it as reached, or the next attach would resume past output no surface ever
   * showed.
   */
  readonly write: (data: string) => boolean
}

export const createTerminalScreen = (): TerminalScreen => {
  let generation = 0
  let canvas: TerminalScreenCanvas | undefined
  const listeners = new Set<() => void>()

  const announce = (): void => {
    // Copy: a listener may restart the attach and unsubscribe as it runs.
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    generation: () => (canvas === undefined ? 0 : generation),

    mount: (next) => {
      canvas = next
      generation += 1
      announce()
    },

    resetAndWrite: (data) => {
      if (canvas === undefined) {
        return false
      }
      canvas.resetAndWrite(data)
      return true
    },

    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    unmount: (previous) => {
      if (canvas !== previous) {
        return
      }
      canvas = undefined
    },

    write: (data) => {
      if (canvas === undefined) {
        // Output with nowhere to land is dropped rather than queued. The
        // surface that eventually mounts is blank and forces a fresh replay,
        // so flushing this chunk into it would double-draw history — and
        // acknowledging it now would release flow control for output no screen
        // ever showed.
        return false
      }
      if (data.length > 0) {
        canvas.write(data)
      }
      return true
    },
  }
}
