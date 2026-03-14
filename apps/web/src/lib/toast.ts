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
 * | loading    | soft (spawn)   |
 * | message    | buttonTap      |
 * | info       | buttonTap      |
 *
 * Usage:
 *   import { toast } from '@/lib/toast'
 *   toast.success('Done!')  // triggers success haptic + shows toast
 */

import { type ExternalToast, toast as sonnerToast } from 'sonner'

import { haptics } from '@/lib/haptics'

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
    haptics.buttonTap()
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
    message: withHaptic(sonnerToast.message, haptics.buttonTap),
    info: withHaptic(sonnerToast.info, haptics.buttonTap),
  }
)

export { toast }
