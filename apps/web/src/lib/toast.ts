/**
 * Haptic-enhanced toast wrapper.
 *
 * Re-exports sonner's `toast` with haptic feedback automatically triggered
 * for each toast type:
 *
 * | Toast type | Haptic pattern |
 * |------------|----------------|
 * | success    | success        |
 * | error      | error          |
 * | warning    | warning        |
 * | loading    | spawn          |
 * | message    | tap            |
 * | info       | tap            |
 *
 * Usage:
 *   import { toast } from '@/lib/toast'
 *   toast.success('Done!')  // triggers success haptic + shows toast
 */

import { haptics } from '@laborer/ui/lib/haptics'
import { type ExternalToast, toast as sonnerToast } from 'sonner'

type ToastFn = typeof sonnerToast
type ToastMessage = Parameters<typeof sonnerToast.success>[0]

/**
 * Create a haptic-enhanced version of a typed sonner toast method.
 */
function withHaptic(
  fn: (message: ToastMessage, data?: ExternalToast) => string | number,
  hapticFn: () => void
): typeof fn {
  return (message, data) => {
    hapticFn()
    return fn(message, data)
  }
}

const toast: ToastFn = Object.assign(
  // Default toast (bare `toast('message')`) — light tap
  ((...args: Parameters<ToastFn>) => {
    haptics.tap()
    return sonnerToast(...args)
  }) as ToastFn,
  {
    // Preserve all static properties and methods from sonner toast
    ...sonnerToast,

    // Override typed methods with haptic-enhanced versions
    success: withHaptic(sonnerToast.success, haptics.success),
    error: withHaptic(sonnerToast.error, haptics.error),
    warning: withHaptic(sonnerToast.warning, haptics.warning),
    loading: withHaptic(sonnerToast.loading, haptics.spawn),
    message: withHaptic(sonnerToast.message, haptics.tap),
    info: withHaptic(sonnerToast.info, haptics.tap),
  }
)

export { toast }
