/**
 * Decides when the desktop must push the machine's power state to the
 * daemon, which derives its power profile (performance on AC,
 * battery-saver on battery) from that signal.
 *
 * This module is pure so the push policy can be unit tested without
 * Electron: the main process feeds it `powerMonitor` transitions and
 * daemon-ensure completions, and it answers "send or not".
 *
 * Policy:
 * - Repeated identical power events are deduped (macOS delivers
 *   duplicates), so an unchanged state costs no HTTP request.
 * - A daemon ensure completion always re-pushes the current state — a
 *   restarted daemon starts on the default battery-saver profile and
 *   must not sit there while the machine is on AC.
 * - A failed send leaves the state undelivered, so the next event or
 *   ensure completion retries instead of being deduped away.
 * - Sends are serialized through a queue so rapid ac→battery→ac
 *   transitions can never be delivered out of order.
 */

export type PowerState = 'ac' | 'battery'

export const powerStateFromBattery = (onBattery: boolean): PowerState =>
  onBattery ? 'battery' : 'ac'

/** Delivers power states to the daemon; returns whether delivery succeeded. */
export type PowerStateSender = (state: PowerState) => Promise<boolean>

export class DaemonPowerStatePusher {
  private readonly send: PowerStateSender
  private current: PowerState | null = null
  private delivered: PowerState | null = null
  private queue: Promise<void> = Promise.resolve()

  constructor(send: PowerStateSender) {
    this.send = send
  }

  /** Record a power state and push it unless already delivered. */
  update(state: PowerState): void {
    this.current = state
    if (state === this.delivered) {
      return
    }
    this.enqueue()
  }

  /**
   * Force a re-push of the current state, regardless of what was last
   * delivered. Call after every daemon ensure (launch/reconnect/version
   * swap): the ensured daemon may be a fresh process holding the default
   * profile. No-op until the first power state is known.
   */
  repush(): void {
    if (this.current === null) {
      return
    }
    this.delivered = null
    this.enqueue()
  }

  private enqueue(): void {
    this.queue = this.queue.then(async () => {
      // Read the latest state at send time so a queued send collapses
      // intermediate transitions instead of replaying them.
      const state = this.current
      if (state === null || state === this.delivered) {
        return
      }
      const ok = await this.send(state).catch(() => false)
      if (ok) {
        this.delivered = state
      }
    })
  }
}
