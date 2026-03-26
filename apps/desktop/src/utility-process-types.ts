/**
 * Types for communication between the Electron main process and
 * utility processes via `process.parentPort` / `MessagePort`.
 *
 * These types define the bootstrap protocol — the messages exchanged
 * during utility process startup.
 */

// ---------------------------------------------------------------------------
// Bootstrap messages (utility process → parent)
// ---------------------------------------------------------------------------

/** Sent when the utility process has successfully loaded its service module. */
export interface UtilityProcessReadyMessage {
  readonly type: 'ready'
}

/** Sent when the utility process fails to load its service module. */
export interface UtilityProcessErrorMessage {
  readonly message: string
  readonly type: 'error'
}

/** All messages the bootstrap can send to the parent process. */
export type UtilityProcessBootstrapMessage =
  | UtilityProcessReadyMessage
  | UtilityProcessErrorMessage
