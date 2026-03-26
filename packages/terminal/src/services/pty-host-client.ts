/**
 * PtyHostClient — Effect Service Tag & Types
 *
 * Defines the `PtyHostClient` service interface for managing PTY processes.
 * The concrete implementation is provided by `pty-direct.ts` which runs
 * node-pty directly inside the utility process (no child process).
 *
 * The previous child-process-based implementation (which spawned a separate
 * pty-host.ts script with ELECTRON_RUN_AS_NODE=1) was removed during the
 * utility process migration (Issue #20). Utility processes run natively in
 * Electron's Node.js context, so node-pty loads correctly without ABI
 * workarounds.
 *
 * @see pty-direct.ts — the concrete implementation
 * @see Issue #6: Terminal utility process (flattened architecture)
 * @see Issue #20: Build script update + port reservation removal
 */

import { Context } from 'effect'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpawnParams {
  readonly args: readonly string[]
  readonly cols: number
  readonly cwd: string
  readonly env: Record<string, string>
  readonly id: string
  readonly rows: number
  readonly shell: string
}

/** Callback invoked when a PTY produces output (raw UTF-8). */
type DataCallback = (data: string) => void

/** Callback invoked when a PTY process exits. */
type ExitCallback = (exitCode: number, signal: number) => void

/** Callback invoked when the PTY Host confirms a PTY has been spawned. */
type SpawnedCallback = (pid: number) => void

/** Callback invoked when the PTY Host process crashes. */
type CrashCallback = () => void

// ---------------------------------------------------------------------------
// Service Definition
// ---------------------------------------------------------------------------

class PtyHostClient extends Context.Tag('@laborer/PtyHostClient')<
  PtyHostClient,
  {
    /**
     * Spawn a new PTY process.
     * Registers data/exit/spawned callbacks for the terminal.
     */
    readonly spawn: (
      params: SpawnParams,
      onData: DataCallback,
      onExit: ExitCallback,
      onSpawned?: SpawnedCallback
    ) => void

    /** Write data to a PTY's stdin. */
    readonly write: (id: string, data: string) => void

    /** Resize a PTY's dimensions. */
    readonly resize: (id: string, cols: number, rows: number) => void

    /** Kill a PTY process. */
    readonly kill: (id: string) => void

    /**
     * Acknowledge processing of `chars` characters for a terminal.
     * Used for flow control: the PTY host decrements its
     * `unacknowledgedCharCount` and resumes the PTY if below
     * the low watermark (Issue #141).
     */
    readonly ack: (id: string, chars: number) => void

    /**
     * Register a callback that is invoked when the PTY host
     * crashes or exits unexpectedly.
     */
    readonly onCrash: (callback: CrashCallback) => void
  }
>() {}

export { PtyHostClient }
export type {
  CrashCallback,
  DataCallback,
  ExitCallback,
  SpawnParams,
  SpawnedCallback,
}
