/**
 * Direct PTY Client — PtyHostClient implementation using node-pty directly
 *
 * Provides the same `PtyHostClient` service interface as `pty-host-client.ts`,
 * but runs node-pty in-process instead of spawning a separate pty-host child
 * process. This "flattened" architecture is used when the terminal runs as
 * an Electron utility process, matching VS Code's pty host pattern.
 *
 * The existing `TerminalManager` service is unchanged — it depends on the
 * `PtyHostClient` tag regardless of whether the underlying implementation
 * uses a child process or direct node-pty calls.
 *
 * Key differences from `pty-host-client.ts`:
 * - No child process spawning (no `ELECTRON_RUN_AS_NODE=1`)
 * - node-pty is imported directly via `createRequire` (same as pty-host.ts)
 * - Data coalescing (5ms buffer) matches pty-host.ts behavior
 * - Flow control (high/low watermark) matches pty-host.ts behavior
 * - Spawn-helper permission fix runs on layer construction
 *
 * @see pty-host.ts — Original child process implementation
 * @see pty-host-client.ts — Child process-based PtyHostClient
 * @see .reference/vscode/src/vs/platform/terminal/node/ptyHostMain.ts
 */

import { createRequire } from 'node:module'
import { Effect, Layer } from 'effect'
import type { IPty } from 'node-pty'
import type {
  CrashCallback,
  DataCallback,
  ExitCallback,
  SpawnedCallback,
  SpawnParams,
} from './pty-host-client.js'
import { PtyHostClient } from './pty-host-client.js'

// createRequire is needed because this runs as ESM where bare require()
// is unavailable. node-pty is a native addon loaded via CJS.
const require_ = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Data coalescing (matches pty-host.ts)
// ---------------------------------------------------------------------------

/** Coalescing interval — batches data events over 5ms windows. */
const COALESCE_INTERVAL_MS = 5

interface CoalesceBuffer {
  readonly chunks: string[]
  readonly timer: ReturnType<typeof setTimeout>
}

// ---------------------------------------------------------------------------
// Flow control (watermarks match VS Code's terminalProcess.ts)
//
// Laborer deliberately diverges from VS Code in one way: flow control is
// only active while at least one data-channel consumer (a renderer pane)
// is attached. VS Code lets a detached PTY pause at the high watermark as
// OS-level backpressure — fine for an idle shell, but Laborer terminals
// run autonomous agents that must keep making progress while no pane is
// watching. A paused PTY fills the kernel buffer and blocks the agent's
// stdout writes, stalling the agent itself.
//
// See docs/adr/0002-flow-control-only-while-attached.md
// ---------------------------------------------------------------------------

const HIGH_WATERMARK_CHARS = 100_000
const LOW_WATERMARK_CHARS = 5000

interface FlowControlState {
  readonly paused: boolean
  unacknowledgedCharCount: number
}

// ---------------------------------------------------------------------------
// Spawn-helper permission fix (from pty-host.ts)
// ---------------------------------------------------------------------------

async function fixSpawnHelperPermissions(): Promise<void> {
  const { readdir, chmod, stat } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')

  let nodePtyDir: string
  try {
    const nodePtyMain = require_.resolve('node-pty')
    nodePtyDir = dirname(nodePtyMain)
    while (nodePtyDir !== '/' && !nodePtyDir.endsWith('node-pty')) {
      nodePtyDir = dirname(nodePtyDir)
    }
  } catch {
    console.error(
      '[pty-direct] Could not resolve node-pty package path, skipping permission fix'
    )
    return
  }

  const prebuildsDir = join(nodePtyDir, 'prebuilds')

  try {
    const platforms = await readdir(prebuildsDir)
    for (const platform of platforms) {
      const helperPath = join(prebuildsDir, platform, 'spawn-helper')
      try {
        const st = await stat(helperPath)
        const isExecutable = Boolean(
          // biome-ignore lint/suspicious/noBitwiseOperators: bitwise check for file permissions
          (st.mode ?? 0) & 0o100
        )
        if (!isExecutable) {
          await chmod(helperPath, 0o755)
          console.error(
            `[pty-direct] Fixed execute permission on ${helperPath}`
          )
        }
      } catch {
        // spawn-helper doesn't exist for this platform, skip
      }
    }
  } catch {
    // No prebuilds directory, skip
  }
}

// ---------------------------------------------------------------------------
// PtyHostClient.directLayer — in-process node-pty
// ---------------------------------------------------------------------------

/**
 * Layer that provides PtyHostClient using node-pty directly (no child process).
 *
 * Used in the utility process entry point to flatten the terminal architecture.
 * The layer is scoped: when finalized, all PTYs are killed and buffers flushed.
 */
const directLayer = Layer.effect(
  PtyHostClient,
  Effect.gen(function* () {
    // In-process state
    const ptys = new Map<string, IPty>()
    const dataCallbacks = new Map<string, DataCallback>()
    const exitCallbacks = new Map<string, ExitCallback>()
    const spawnedCallbacks = new Map<string, SpawnedCallback>()
    const crashCallbacks: CrashCallback[] = []
    const coalesceBuffers = new Map<string, CoalesceBuffer>()
    const flowControlStates = new Map<string, FlowControlState>()
    const ptyGenerations = new Map<string, number>()

    /**
     * Number of attached data-channel consumers per terminal.
     * Tracked independently of `flowControlStates` because consumers
     * outlive PTY respawns (restart keeps channels attached) and a
     * channel can attach to a stopped terminal.
     */
    const flowControlConsumerCounts = new Map<string, number>()

    /**
     * Zero the unacknowledged counter and force-resume a paused PTY.
     * Equivalent to VS Code's `clearUnacknowledgedChars` — ack debt
     * never survives a consumer attach/detach transition.
     */
    function clearFlowControl(id: string): void {
      const fcState = flowControlStates.get(id)
      if (fcState === undefined) {
        return
      }

      fcState.unacknowledgedCharCount = 0
      if (fcState.paused) {
        const pty = ptys.get(id)
        if (pty !== undefined) {
          pty.resume()
        }
        ;(fcState as { paused: boolean }).paused = false
      }
    }

    // Fix spawn-helper permissions before anything else
    yield* Effect.promise(() => fixSpawnHelperPermissions())

    // -------------------------------------------------------------------
    // Data coalescing helpers (from pty-host.ts)
    // -------------------------------------------------------------------

    /**
     * Count emitted chars and pause the PTY at the high watermark.
     * Only active while a consumer is attached — detached terminals
     * always flow so background agents never stall on a full kernel
     * buffer.
     */
    function trackEmittedChars(id: string, charCount: number): void {
      const fcState = flowControlStates.get(id)
      const hasConsumers = (flowControlConsumerCounts.get(id) ?? 0) > 0
      if (fcState === undefined || !hasConsumers) {
        return
      }

      fcState.unacknowledgedCharCount += charCount

      if (
        !fcState.paused &&
        fcState.unacknowledgedCharCount > HIGH_WATERMARK_CHARS
      ) {
        const pty = ptys.get(id)
        if (pty !== undefined) {
          pty.pause()
          ;(fcState as { paused: boolean }).paused = true
        }
      }
    }

    function flushCoalesceBuffer(id: string): void {
      const buf = coalesceBuffers.get(id)
      if (buf === undefined) {
        return
      }
      clearTimeout(buf.timer)
      coalesceBuffers.delete(id)

      const joined = buf.chunks.join('')
      if (joined.length > 0) {
        const dataCb = dataCallbacks.get(id)
        if (dataCb !== undefined) {
          dataCb(joined)
        }

        trackEmittedChars(id, joined.length)
      }
    }

    function bufferData(id: string, data: string): void {
      const existing = coalesceBuffers.get(id)
      if (existing !== undefined) {
        existing.chunks.push(data)
        return
      }

      const chunks = [data]
      const timer = setTimeout(() => {
        flushCoalesceBuffer(id)
      }, COALESCE_INTERVAL_MS)

      coalesceBuffers.set(id, { chunks, timer })
    }

    // -------------------------------------------------------------------
    // Cleanup on scope finalization
    // -------------------------------------------------------------------

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // Flush all coalescing buffers
        for (const id of [...coalesceBuffers.keys()]) {
          flushCoalesceBuffer(id)
        }

        // Kill all remaining PTYs
        for (const [id, pty] of ptys) {
          try {
            pty.kill()
          } catch {
            // Best effort cleanup
          }
          ptys.delete(id)
        }

        // Clear all state
        dataCallbacks.clear()
        exitCallbacks.clear()
        spawnedCallbacks.clear()
        flowControlStates.clear()
        flowControlConsumerCounts.clear()
        ptyGenerations.clear()
      })
    )

    // -------------------------------------------------------------------
    // Service implementation
    // -------------------------------------------------------------------

    return PtyHostClient.of({
      spawn: (
        params: SpawnParams,
        onData: DataCallback,
        onExit: ExitCallback,
        onSpawned?: SpawnedCallback
      ) => {
        const existingPty = ptys.get(params.id)
        if (existingPty !== undefined) {
          try {
            flushCoalesceBuffer(params.id)
            existingPty.kill()
          } catch (error) {
            console.error(
              `[pty-direct] Failed to replace existing PTY ${params.id}: ${String(error)}`
            )
          }
        }

        const generation = (ptyGenerations.get(params.id) ?? 0) + 1
        ptyGenerations.set(params.id, generation)

        // Register callbacks before spawning to avoid races
        dataCallbacks.set(params.id, onData)
        exitCallbacks.set(params.id, onExit)
        if (onSpawned) {
          spawnedCallbacks.set(params.id, onSpawned)
        }

        try {
          const nodePty = require_('node-pty') as typeof import('node-pty')

          const pty = nodePty.spawn(params.shell, params.args as string[], {
            name: 'xterm-256color',
            cols: params.cols,
            rows: params.rows,
            cwd: params.cwd,
            env: params.env,
          })

          ptys.set(params.id, pty)

          // Initialize flow control state
          flowControlStates.set(params.id, {
            unacknowledgedCharCount: 0,
            paused: false,
          })

          // Forward PTY output through the coalescing buffer
          pty.onData((data: string) => {
            if (ptyGenerations.get(params.id) !== generation) {
              return
            }
            bufferData(params.id, data)
          })

          // Forward PTY exit
          pty.onExit(({ exitCode, signal }) => {
            if (ptyGenerations.get(params.id) !== generation) {
              return
            }

            const code = exitCode ?? -1
            const sig = signal ?? -1

            // Flush pending coalesced output before exit
            flushCoalesceBuffer(params.id)

            ptys.delete(params.id)
            flowControlStates.delete(params.id)
            ptyGenerations.delete(params.id)

            const exitCb = exitCallbacks.get(params.id)
            if (exitCb !== undefined) {
              exitCb(code, sig)
            }
            dataCallbacks.delete(params.id)
            exitCallbacks.delete(params.id)
            spawnedCallbacks.delete(params.id)
          })

          // Notify spawned callback
          const spawnedCb = spawnedCallbacks.get(params.id)
          if (spawnedCb !== undefined) {
            spawnedCb(pty.pid)
            spawnedCallbacks.delete(params.id)
          }
        } catch (error) {
          console.error(`[pty-direct] Failed to spawn PTY: ${String(error)}`)
          // Clean up callbacks on failure
          dataCallbacks.delete(params.id)
          exitCallbacks.delete(params.id)
          spawnedCallbacks.delete(params.id)
          ptyGenerations.delete(params.id)
        }
      },

      write: (id: string, data: string) => {
        const pty = ptys.get(id)
        if (pty === undefined) {
          console.error(`[pty-direct] PTY not found: ${id}`)
          return
        }

        try {
          pty.write(data)
        } catch (error) {
          console.error(
            `[pty-direct] Failed to write to PTY ${id}: ${String(error)}`
          )
        }
      },

      resize: (id: string, cols: number, rows: number) => {
        const pty = ptys.get(id)
        if (pty === undefined) {
          console.error(`[pty-direct] PTY not found: ${id}`)
          return
        }

        try {
          // Flush pending data before resize (matches pty-host.ts)
          flushCoalesceBuffer(id)
          pty.resize(cols, rows)
        } catch (error) {
          console.error(
            `[pty-direct] Failed to resize PTY ${id}: ${String(error)}`
          )
        }
      },

      kill: (id: string) => {
        const pty = ptys.get(id)
        if (pty === undefined) {
          console.error(`[pty-direct] PTY not found: ${id}`)
          return
        }

        try {
          // Flush pending data before kill (matches pty-host.ts)
          flushCoalesceBuffer(id)
          pty.kill()
        } catch (error) {
          console.error(
            `[pty-direct] Failed to kill PTY ${id}: ${String(error)}`
          )
        }
      },

      ack: (id: string, chars: number) => {
        const fcState = flowControlStates.get(id)
        if (fcState === undefined) {
          return
        }

        fcState.unacknowledgedCharCount = Math.max(
          0,
          fcState.unacknowledgedCharCount - chars
        )

        if (
          fcState.paused &&
          fcState.unacknowledgedCharCount < LOW_WATERMARK_CHARS
        ) {
          const pty = ptys.get(id)
          if (pty !== undefined) {
            pty.resume()
            ;(fcState as { paused: boolean }).paused = false
          }
        }
      },

      attachFlowControlConsumer: (id: string) => {
        const count = flowControlConsumerCounts.get(id) ?? 0
        flowControlConsumerCounts.set(id, count + 1)

        // Reset on every attach: ack debt accumulated by a previous
        // (possibly dead) consumer never carries over to a new one.
        clearFlowControl(id)
      },

      detachFlowControlConsumer: (id: string) => {
        const count = flowControlConsumerCounts.get(id) ?? 0
        const next = Math.max(0, count - 1)

        if (next === 0) {
          flowControlConsumerCounts.delete(id)
          // Last consumer gone — release any backpressure so the
          // terminal keeps flowing while unwatched.
          clearFlowControl(id)
        } else {
          flowControlConsumerCounts.set(id, next)
        }
      },

      onCrash: (callback: CrashCallback) => {
        crashCallbacks.push(callback)
      },
    })
  })
)

export { directLayer }
