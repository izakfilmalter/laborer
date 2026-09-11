import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/terminal/ghostty/vendor/ghostty-vt.wasm?url', async () => ({
  default: (
    await import('../src/terminal/ghostty/vendor/ghostty-vt.wasm?inline')
  ).default,
}))
vi.mock(
  '../src/terminal/ghostty/vendor/ghostty-write-pty.wasm?url&no-inline',
  async () => ({
    default: (
      await import(
        '../src/terminal/ghostty/vendor/ghostty-write-pty.wasm?inline'
      )
    ).default,
  })
)
vi.mock('../src/terminal/ghostty/renderer', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/terminal/ghostty/renderer')
  >()),
  renderGhosttySnapshot: vi.fn(),
}))

import { renderGhosttySnapshot } from '../src/terminal/ghostty/renderer'
import { GhosttyTerminalSurface } from '../src/terminal/ghostty/surface'

const draw = vi.mocked(renderGhosttySnapshot)
const surfaces: GhosttyTerminalSurface[] = []
const frames = new Map<number, FrameRequestCallback>()
const originalFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
let frameId = 0

beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) =>
    Object.assign(new EventTarget(), { matches: false, media })
  )
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      load: () => Promise.resolve([]),
      check: () => true,
    }),
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fillRect: vi.fn(),
    setTransform: vi.fn(),
    measureText: (text: string) => ({
      width: text.length * 8,
      actualBoundingBoxAscent: 12,
      actualBoundingBoxDescent: 4,
    }),
  } as unknown as CanvasRenderingContext2D)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
})

afterEach(() => {
  for (const surface of surfaces.splice(0)) {
    surface.dispose()
  }
  frames.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalFonts) {
    Object.defineProperty(document, 'fonts', originalFonts)
  } else {
    Reflect.deleteProperty(document, 'fonts')
  }
})

async function createSurface() {
  const mount = document.createElement('div')
  let width = 648
  Object.defineProperties(mount, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => 392 },
  })
  document.body.append(mount)
  const onData = vi.fn()
  const surface = await GhosttyTerminalSurface.create(mount, {
    beforeKey: () => true,
    onData,
    onLinkActivate: vi.fn(),
    onResize: vi.fn(),
    onSelectionChange: vi.fn(),
    theme: {
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 255, g: 255, b: 255 },
      cursor: { r: 255, g: 255, b: 255 },
    },
  })
  surfaces.push(surface)
  draw.mockClear()
  return {
    surface,
    onData,
    setWidth: (value: number) => {
      width = value
    },
  }
}

function lastDrawnText(): string {
  return (
    draw.mock.lastCall?.[0].snapshot.rowData
      .map((row) => row.text)
      .join('\n') ?? ''
  )
}

describe('Ghostty output rendering', () => {
  it('draws each parsed output update without waiting for an animation frame', async () => {
    const { surface } = await createSurface()
    surface.write('j')
    expect(lastDrawnText()).toContain('j')
    surface.write('kl')
    expect(lastDrawnText()).toContain('jkl')
    expect(draw).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(0)
  })

  it('consumes a pending redraw rather than drawing the same update twice', async () => {
    const { surface } = await createSurface()
    surface.input.dispatchEvent(new FocusEvent('focus'))
    expect(frames.size).toBe(1)
    surface.write('echo')
    expect(lastDrawnText()).toContain('echo')
    expect(frames.size).toBe(0)
    expect(draw).toHaveBeenCalledOnce()
  })

  it('parses and answers queries while hidden, then redraws on restoration', async () => {
    const { surface, onData } = await createSurface()
    surface.setVisible(false)
    surface.write('hidden output\x1b[?2026$p')
    expect(onData).toHaveBeenCalledWith('\x1b[?2026;2$y')
    expect(draw).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    surface.setVisible(true)
    expect(lastDrawnText()).toContain('hidden output')
  })

  it('preserves output while zero-sized and does no work after disposal', async () => {
    const { surface, setWidth } = await createSurface()
    setWidth(0)
    surface.fit()
    surface.write('zero-sized output')
    expect(draw).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    setWidth(648)
    surface.fit()
    expect(lastDrawnText()).toContain('zero-sized output')
    draw.mockClear()
    surface.dispose()
    surface.write('disposed output')
    expect(draw).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })
})
