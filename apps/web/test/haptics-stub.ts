import { vi } from 'vitest'

/**
 * Stub for `@laborer/ui/lib/haptics` in jsdom.
 *
 * `web-haptics` reaches for the Vibration and Web Audio APIs, which jsdom does
 * not implement, so tests replace the module wholesale.
 *
 * Returns a Proxy that mints a `vi.fn()` on first access of any method and
 * returns the same spy thereafter. Listing methods explicitly meant every test
 * broke whenever a component started using a new haptic — a UI detail that
 * these tests do not care about. Assertions still work:
 *
 *   expect(haptics.press).toHaveBeenCalled()
 */
function createHapticsStub(): Record<string, ReturnType<typeof vi.fn>> {
  const spies = new Map<string, ReturnType<typeof vi.fn>>()

  return new Proxy({} as Record<string, ReturnType<typeof vi.fn>>, {
    get(_target, property) {
      if (typeof property !== 'string') {
        return
      }
      let spy = spies.get(property)
      if (!spy) {
        spy = vi.fn()
        spies.set(property, spy)
      }
      return spy
    },
  })
}

export { createHapticsStub }
