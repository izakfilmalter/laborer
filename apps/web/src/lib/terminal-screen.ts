/**
 * The screen a terminal pane draws on, and the identity of that screen.
 *
 * A pane's canvas and its attach stream have independent lifetimes. React
 * rebuilds the canvas when the pane adopts a different terminal, and again
 * when StrictMode double-invokes the mount, while the daemon connection is
 * untouched; the daemon drops and restores the stream while the same canvas
 * stays mounted. Anything derived from what has been *drawn* therefore belongs
 * to the canvas rather than to the pane that hosts it.
 *
 * Each mounted canvas is given a generation so a resume cursor can name the
 * screen it describes. A rebuilt canvas is blank: resuming from the cursor the
 * previous one reached would ask the daemon to continue a screen nobody can
 * see, leaving the operator with deltas and no history underneath them.
 * Generation `0` means no canvas is mounted at all.
 *
 * @see apps/web/src/hooks/use-terminal-rpc.ts — attaches against a generation
 * @see apps/web/src/panes/terminal-pane.tsx — mounts the xterm canvas
 */

/** The slice of xterm a screen draws through. */
export interface TerminalScreenCanvas {
  readonly reset: () => void
  readonly write: (data: string, commit: () => void) => void
}

export interface TerminalScreen {
  /** Identifies the mounted canvas; `0` while none is mounted. */
  readonly generation: () => number
  /** Adopt a freshly built, blank canvas. */
  readonly mount: (canvas: TerminalScreenCanvas) => void
  /** Clear the visible screen without replacing the canvas. */
  readonly reset: () => void
  /** Observe canvas replacement. Listeners read `generation` for the new one. */
  readonly subscribe: (listener: () => void) => () => void
  /** Retire a canvas. A stale cleanup cannot retire the one that replaced it. */
  readonly unmount: (canvas: TerminalScreenCanvas) => void
  /**
   * Draw a chunk. `commit` runs once the canvas reports it parsed.
   *
   * Reports whether a canvas took the chunk. A screen with nothing mounted
   * drops it, and a dropped chunk was never drawn: the caller must not count
   * it as reached, or the next attach would resume past output no canvas ever
   * showed.
   */
  readonly write: (data: string, commit: () => void) => boolean
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

    reset: () => {
      canvas?.reset()
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

    write: (data, commit) => {
      const target = canvas
      if (target === undefined) {
        // Output with nowhere to land is dropped rather than queued. The
        // canvas that eventually mounts is blank and forces a fresh replay,
        // so flushing this chunk into it would double-draw history — and
        // committing it now would acknowledge output no screen ever showed.
        return false
      }
      const commitToTarget = (): void => {
        // xterm can report a chunk parsed after its canvas has been replaced.
        // That parse belongs to a screen the operator can no longer see, so it
        // must not advance the cursor the next attach resumes from.
        if (canvas !== target) {
          return
        }
        commit()
      }
      if (data.length === 0) {
        commitToTarget()
        return true
      }
      target.write(data, commitToTarget)
      return true
    },
  }
}
