/**
 * Centralized haptic feedback module.
 *
 * Provides audio-based haptic feedback for the desktop app using the
 * web-haptics library (Web Audio API). Wraps the library's preset patterns
 * with semantic names that map to UI interactions.
 *
 * Usage:
 *   import { haptics } from '@/lib/haptics'
 *   haptics.buttonTap()      // light tap for button clicks
 *   haptics.success()        // success confirmation
 *   haptics.error()          // error alert
 *   haptics.notification()   // nudge for attention
 *
 * @see https://haptics.lochie.me — WebHaptics demo & docs
 */

import { WebHaptics } from 'web-haptics'

/** Singleton WebHaptics instance, lazily initialized on first trigger. */
let instance: WebHaptics | null = null

/**
 * Whether the user has interacted with the page (click, touch, keydown).
 *
 * Browsers block `navigator.vibrate()` until the user has tapped or clicked
 * on the frame. We track the first interaction and silently skip haptic
 * triggers before it to avoid "[Intervention] Blocked call to
 * navigator.vibrate" console warnings.
 */
let userHasInteracted = false

if (typeof window !== 'undefined') {
  const markInteracted = () => {
    userHasInteracted = true
    window.removeEventListener('click', markInteracted, true)
    window.removeEventListener('touchstart', markInteracted, true)
    window.removeEventListener('keydown', markInteracted, true)
  }
  window.addEventListener('click', markInteracted, true)
  window.addEventListener('touchstart', markInteracted, true)
  window.addEventListener('keydown', markInteracted, true)
}

function getInstance(): WebHaptics | null {
  if (!userHasInteracted) {
    return null
  }
  if (!instance) {
    instance = new WebHaptics()
  }
  return instance
}

/**
 * Semantic haptic feedback triggers mapped to UI interactions.
 *
 * Each method wraps a specific preset pattern from web-haptics:
 *
 * | Method           | Preset      | Use case                                    |
 * |------------------|-------------|---------------------------------------------|
 * | buttonTap        | light       | Standard button clicks                      |
 * | selection        | selection   | Toggle, switch, checkbox state changes       |
 * | success          | success     | Successful operations, toast.success         |
 * | warning          | warning     | Warning notifications, toast.warning         |
 * | error            | error       | Error notifications, toast.error             |
 * | heavyImpact      | heavy       | Destructive actions (destroy, delete, force)  |
 * | notification     | nudge       | Attention-needed, agent waiting for input     |
 * | dialogOpen       | medium      | Dialog/modal appearance                      |
 * | copy             | rigid       | Clipboard copy confirmation                  |
 * | spawn            | soft        | Terminal/agent spawn, workspace creation      |
 * | crash            | buzz        | Sidecar service crash                        |
 */
const haptics = {
  /** Light tap — standard button click. */
  buttonTap() {
    getInstance()?.trigger('light')
  },

  /** Micro-tap — toggle, switch, checkbox state change. */
  selection() {
    getInstance()?.trigger('selection')
  },

  /** Success double-tap — operation completed. */
  success() {
    getInstance()?.trigger('success')
  },

  /** Warning double-tap — attention advised. */
  warning() {
    getInstance()?.trigger('warning')
  },

  /** Error staccato — operation failed. */
  error() {
    getInstance()?.trigger('error')
  },

  /** Heavy single tap — destructive or irreversible action. */
  heavyImpact() {
    getInstance()?.trigger('heavy')
  },

  /** Nudge — agent needs attention / waiting for input. */
  notification() {
    getInstance()?.trigger('nudge')
  },

  /** Medium tap — dialog or modal opening. */
  dialogOpen() {
    getInstance()?.trigger('medium')
  },

  /** Rigid snap — clipboard copy. */
  copy() {
    getInstance()?.trigger('rigid')
  },

  /** Soft tap — terminal/agent spawn, workspace creation. */
  spawn() {
    getInstance()?.trigger('soft')
  },

  /** Long buzz — sidecar crash alert. */
  crash() {
    getInstance()?.trigger('buzz')
  },
} as const

export { haptics }
