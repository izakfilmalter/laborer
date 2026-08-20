import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

/**
 * Records every preset the haptics module asks the library to play.
 *
 * Faked rather than exercised for real because `web-haptics` reaches for the
 * Vibration and Web Audio APIs, which jsdom does not implement.
 */
const triggered: string[] = []

/** Records cancellations so preemption can be asserted. */
const cancels: string[] = []

vi.mock('web-haptics', () => ({
  WebHaptics: class {
    trigger(preset: string) {
      triggered.push(preset)
      return Promise.resolve()
    }
    cancel() {
      cancels.push('cancel')
    }
  },
}))

const { haptics, installInteractiveTapFallback } = await import(
  '../src/lib/haptics'
)

/**
 * The module ignores haptics until the user has interacted with the frame,
 * because browsers block `navigator.vibrate()` before then.
 */
function primeUserInteraction() {
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// Installed once for the whole file. Re-installing per test would reset the
// clock to real "now", which reads as time travelling backwards against the
// module's last-trigger timestamp and wedges coalescing on permanently.
beforeAll(() => {
  vi.useFakeTimers()
  primeUserInteraction()
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  // Leave the coalesce window well behind so the previous test cannot swallow
  // the first haptic of this one.
  vi.advanceTimersByTime(500)
  triggered.length = 0
  cancels.length = 0
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('haptic vocabulary', () => {
  it('maps each semantic name to its preset', () => {
    haptics.press()
    vi.advanceTimersByTime(500)
    haptics.tap()
    vi.advanceTimersByTime(500)
    haptics.selection()
    vi.advanceTimersByTime(500)
    haptics.heavyImpact()

    expect(triggered).toEqual(['medium', 'light', 'selection', 'heavy'])
  })

  it('distinguishes expanding from collapsing', () => {
    haptics.expand()
    vi.advanceTimersByTime(500)
    haptics.collapse()

    expect(triggered).toEqual(['soft', 'light'])
  })
})

describe('gesture coalescing', () => {
  it('plays only the first haptic of a single gesture', () => {
    // A Button inside a DialogTrigger: both fire on one press.
    haptics.press()
    haptics.dialogOpen()

    expect(triggered).toEqual(['medium'])
  })

  it('still plays an async outcome that lands after the click', () => {
    haptics.press()
    vi.advanceTimersByTime(500)
    haptics.success()

    expect(triggered).toEqual(['medium', 'success'])
  })

  it('lets an immediate outcome interrupt the tap that caused it', () => {
    // Optimistic save: the button acknowledges, then the result lands at once.
    haptics.press()
    haptics.success()

    expect(triggered).toEqual(['medium', 'success'])
    // The tap is cancelled so the two patterns cannot overlap.
    expect(cancels).toHaveLength(1)
  })

  it('does not let a second outcome interrupt the first', () => {
    haptics.error()
    haptics.error()

    expect(triggered).toEqual(['error'])
  })
})

describe('interactive tap fallback', () => {
  let uninstall: () => void

  beforeEach(() => {
    uninstall = installInteractiveTapFallback()
  })

  afterEach(() => {
    uninstall()
  })

  it('taps for a raw button that declares no haptic of its own', () => {
    document.body.innerHTML = '<button type="button">Go</button>'
    const button = document.querySelector('button')

    button?.click()

    expect(triggered).toEqual(['light'])
  })

  it('yields to a richer haptic already fired by the component', () => {
    document.body.innerHTML = '<button type="button">Delete</button>'
    const button = document.querySelector('button')
    button?.addEventListener('click', () => haptics.heavyImpact())

    button?.click()

    expect(triggered).toEqual(['heavy'])
  })

  it('stays silent for non-interactive content', () => {
    document.body.innerHTML = '<p>Just text</p>'

    document.querySelector('p')?.click()

    expect(triggered).toEqual([])
  })

  it('respects an explicit opt-out', () => {
    document.body.innerHTML =
      '<div data-haptic="off"><button type="button">Quiet</button></div>'

    document.querySelector('button')?.click()

    expect(triggered).toEqual([])
  })

  it('stays silent for a disabled control', () => {
    document.body.innerHTML =
      '<span role="button" aria-disabled="true">Nope</span>'

    document.querySelector('[role="button"]')?.click()

    expect(triggered).toEqual([])
  })
})
