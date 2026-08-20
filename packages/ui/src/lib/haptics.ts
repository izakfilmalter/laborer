/**
 * Centralized haptic feedback module.
 *
 * This is the single source of truth for haptics across the app. Components
 * never call `trigger()` with a raw preset name — they import a semantic
 * method from here so the vocabulary stays consistent and reviewable.
 *
 * Names encode intent (`press`, `collapse`, `dismiss`) while presets encode
 * feel. Several intents deliberately share a preset — that is a feature, not
 * duplication. It lets us retune the texture of "collapse" later without
 * hunting through call sites.
 *
 * Usage:
 *   import { haptics } from '@laborer/ui/lib/haptics'
 *   haptics.press()     // primary button — the "commit" thump
 *   haptics.tap()       // secondary button, menu item
 *   haptics.selection() // toggle, tab, checkbox
 *
 * Design rules (Apple HIG):
 *   1. Haptics supplement, never replace, visual feedback.
 *   2. Match intensity to significance.
 *   3. For async work, fire on the RESULT, synced to the visual change.
 *
 * One gesture only ever produces one haptic: nested surfaces are coalesced
 * automatically (see `GESTURE_COALESCE_MS`), so components are free to declare
 * the feedback they deserve without checking what wraps them.
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
    // `debug: true` enables WebHaptics' Web Audio fallback, which renders the
    // pattern as an audible click. Desktop hardware cannot vibrate, so this is
    // what makes haptics perceivable in the Electron shell. It is intentional.
    instance = new WebHaptics({ debug: true })
  }
  return instance
}

/**
 * Window in which a second haptic is treated as part of the same gesture.
 *
 * One press often travels through several layers — a `Button` inside a
 * `DialogTrigger` fires both the button's tap and the dialog's open. Two
 * patterns overlapping read as mush rather than as two events, so the first
 * one wins and the rest of the gesture is swallowed.
 *
 * Kept short so a genuinely separate outcome (an async `success` landing after
 * a request) is never mistaken for part of the click that started it.
 */
const GESTURE_COALESCE_MS = 50

/**
 * Patterns that report an outcome rather than acknowledge a press.
 *
 * These outrank impact and selection patterns. A button that optimistically
 * succeeds fires its own tap and then `success` a beat later, and the outcome
 * is the part the user actually needs to feel.
 */
const OUTCOME_PRESETS = new Set([
  'success',
  'warning',
  'error',
  'nudge',
  'buzz',
])

let lastTriggerAt = Number.NEGATIVE_INFINITY
let lastWasOutcome = false

/**
 * Play a preset unless another haptic already claimed this gesture.
 *
 * Every semantic method below funnels through here, which is what keeps the
 * "one haptic per user gesture" rule true no matter how components nest. An
 * outcome may still interrupt an acknowledgement, in which case the earlier
 * pattern is cancelled so the two never overlap into mush.
 */
function fire(preset: string): void {
  const haptic = getInstance()
  if (!haptic) {
    return
  }

  const now = Date.now()
  const isOutcome = OUTCOME_PRESETS.has(preset)

  if (now - lastTriggerAt < GESTURE_COALESCE_MS) {
    if (!isOutcome || lastWasOutcome) {
      return
    }
    haptic.cancel()
  }

  lastTriggerAt = now
  lastWasOutcome = isOutcome
  haptic.trigger(preset)
}

/**
 * Semantic haptic feedback triggers mapped to UI interactions.
 *
 * | Method       | Preset    | Use case                                        |
 * |--------------|-----------|-------------------------------------------------|
 * | press        | medium    | Primary/commit button — submit, confirm, create |
 * | tap          | light     | Secondary, outline, ghost, link button; menu item |
 * | heavyImpact  | heavy     | Destructive or irreversible action              |
 * | commit       | medium    | Slider release, drag-and-drop snap into place   |
 * | selection    | selection | Switch, checkbox, radio, toggle, tab, slider tick |
 * | dialogOpen   | medium    | Dialog, sheet, drawer, popover opens            |
 * | dismiss      | soft      | Overlay closes or is swiped away                |
 * | expand       | soft      | Accordion/collapsible opens                     |
 * | collapse     | light     | Accordion/collapsible closes                    |
 * | success      | success   | Operation completed, toast.success              |
 * | warning      | warning   | Attention advised, toast.warning                |
 * | error        | error     | Operation failed, toast.error                   |
 * | notification | nudge     | Agent needs attention / waiting for input       |
 * | copy         | rigid     | Clipboard copy confirmation                     |
 * | spawn        | soft      | Terminal/agent spawn, workspace creation        |
 * | crash        | buzz      | Sidecar service crash                           |
 */
const haptics = {
  // ---------------------------------------------------------------------
  // Impact — direct manipulation. Weight tracks the significance of the act.
  // ---------------------------------------------------------------------

  /** Medium thump — primary/commit button: submit, confirm, create. */
  press() {
    fire('medium')
  },

  /** Light tap — secondary, outline, ghost, link buttons and menu items. */
  tap() {
    fire('light')
  },

  /** Heavy single tap — destructive or irreversible action. */
  heavyImpact() {
    fire('heavy')
  },

  /** Medium thump — a value dropped into place: slider release, drag snap. */
  commit() {
    fire('medium')
  },

  // ---------------------------------------------------------------------
  // Selection — discrete stepping. One crisp tick per detent, never more.
  // ---------------------------------------------------------------------

  /** Micro-tick — switch, checkbox, radio, toggle, tab, slider detent. */
  selection() {
    fire('selection')
  },

  // ---------------------------------------------------------------------
  // Surfaces — things arriving and leaving. Opening is crisper than closing.
  // ---------------------------------------------------------------------

  /** Medium tap — dialog, sheet, drawer or popover appearing. */
  dialogOpen() {
    fire('medium')
  },

  /** Soft settle — overlay closing or swiped away. */
  dismiss() {
    fire('soft')
  },

  /** Soft swell — accordion/collapsible opening. */
  expand() {
    fire('soft')
  },

  /** Light tick — accordion/collapsible closing. */
  collapse() {
    fire('light')
  },

  // ---------------------------------------------------------------------
  // Outcomes — fire on the result, synced with the visual state change.
  // ---------------------------------------------------------------------

  /** Success double-tap — operation completed. */
  success() {
    fire('success')
  },

  /** Warning double-tap — attention advised. */
  warning() {
    fire('warning')
  },

  /** Error staccato — operation failed. */
  error() {
    fire('error')
  },

  /** Nudge — agent needs attention / waiting for input. */
  notification() {
    fire('nudge')
  },

  /** Long buzz — sidecar crash alert. */
  crash() {
    fire('buzz')
  },

  // ---------------------------------------------------------------------
  // Domain specifics — reserved for moments that earn their own texture.
  // ---------------------------------------------------------------------

  /** Rigid snap — clipboard copy. */
  copy() {
    fire('rigid')
  },

  /** Soft tap — terminal/agent spawn, workspace creation. */
  spawn() {
    fire('soft')
  },
} as const

/** Elements that a user reasonably expects to feel when they press them. */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
].join(',')

/**
 * Give every interactive element a baseline `tap`, including raw `<button>`s.
 *
 * Most of the app goes through the shared primitives above, but plenty of
 * one-off `<button>`s do not, and wiring each by hand guarantees drift as new
 * ones are added. This listens at the document instead, so coverage is the
 * default and silence is the exception.
 *
 * Runs in the bubble phase, which puts it after React's handlers. Anything
 * that already declared a richer haptic — `press`, `heavyImpact`, `selection`
 * — has therefore fired first and coalescing swallows this fallback. The
 * specific intent always wins; this only fills gaps.
 *
 * Opt an element out with `data-haptic="off"`.
 *
 * @returns cleanup function that removes the listener
 */
function installInteractiveTapFallback(): () => void {
  if (typeof document === 'undefined') {
    return () => {
      // No document to listen on; nothing to clean up.
    }
  }

  const onClick = (event: MouseEvent) => {
    const target = event.target
    if (!(target instanceof Element)) {
      return
    }
    const interactive = target.closest(INTERACTIVE_SELECTOR)
    if (!interactive || interactive.closest('[data-haptic="off"]')) {
      return
    }
    if (interactive.matches(':disabled,[aria-disabled="true"]')) {
      return
    }
    haptics.tap()
  }

  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}

export { haptics, installInteractiveTapFallback }
