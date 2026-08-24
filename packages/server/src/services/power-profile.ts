/**
 * PowerProfile — Effect Service
 *
 * Holds the daemon-wide power profile that trades responsiveness against
 * battery drain. Exactly two knobs vary between profiles:
 *
 * - GitHub PR polling intervals (see polling-intervals.ts)
 * - PTY output coalesce window (pushed to the detached pty-host)
 *
 * The desktop app is the only signal source: Electron's `powerMonitor`
 * reports `on-ac` / `on-battery` transitions, which the desktop pushes to
 * the daemon over the `/daemon/power-state` control endpoint. When no
 * signal has ever been received (web-browser client, headless daemon) the
 * profile stays at `battery-saver` — the previously shipped behavior — so
 * a missing signal is never a regression.
 */

import {
  Context,
  Effect,
  Layer,
  Schema,
  type Stream,
  SubscriptionRef,
} from 'effect'

// ---------------------------------------------------------------------------
// Boundary schemas
// ---------------------------------------------------------------------------

/** Power source reported by the desktop's `powerMonitor`. */
export const PowerState = Schema.Literals(['ac', 'battery'])
export type PowerState = typeof PowerState.Type

/** Profile derived from the power state. */
export const PowerProfile = Schema.Literals(['performance', 'battery-saver'])
export type PowerProfile = typeof PowerProfile.Type

/**
 * Body of `POST /daemon/power-state`. Process-boundary data — decoded
 * with Schema per repository rules.
 */
export const PowerStatePayload = Schema.Struct({
  powerState: PowerState,
})
export type PowerStatePayload = typeof PowerStatePayload.Type

/**
 * The profile assumed until a power signal arrives. Battery-saver is the
 * currently shipped behavior, so clients that never push a signal
 * (browser, headless daemon) keep exactly what they had.
 */
export const DEFAULT_POWER_PROFILE: PowerProfile = 'battery-saver'

/** AC power buys responsiveness; battery buys idle drain. */
export const profileForPowerState = (state: PowerState): PowerProfile =>
  state === 'ac' ? 'performance' : 'battery-saver'

// ---------------------------------------------------------------------------
// PTY output coalesce window per profile
// ---------------------------------------------------------------------------

/** Half-frame window on AC — snappier terminal output at ~120 emits/sec. */
export const PERFORMANCE_COALESCE_WINDOW_MS = 8

/**
 * One frame at 60fps — matches `COALESCE_WINDOW_MS_DEFAULT` in
 * `@laborer/terminal` (lib/coalescing-data-handler.ts), which is what a
 * freshly started pty-host uses before any profile push arrives.
 */
export const BATTERY_SAVER_COALESCE_WINDOW_MS = 16

export const coalesceWindowMsForProfile = (profile: PowerProfile): number =>
  profile === 'performance'
    ? PERFORMANCE_COALESCE_WINDOW_MS
    : BATTERY_SAVER_COALESCE_WINDOW_MS

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PowerProfileService extends Context.Service<
  PowerProfileService,
  {
    /** Emits the profile on every change (SubscriptionRef semantics). */
    readonly changes: Stream.Stream<PowerProfile>
    /** The profile currently in force. */
    readonly getProfile: Effect.Effect<PowerProfile>
    /** Derive and store the profile for a power state; returns it. */
    readonly setPowerState: (state: PowerState) => Effect.Effect<PowerProfile>
  }
>()('@laborer/server/PowerProfileService') {
  static readonly layer = Layer.effect(
    PowerProfileService,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<PowerProfile>(
        DEFAULT_POWER_PROFILE
      )
      return PowerProfileService.of({
        changes: SubscriptionRef.changes(ref),
        getProfile: SubscriptionRef.get(ref),
        setPowerState: (state: PowerState) => {
          const profile = profileForPowerState(state)
          return SubscriptionRef.set(ref, profile).pipe(Effect.as(profile))
        },
      })
    })
  )
}
