import { describe, expect, it, vi } from 'vitest'
import {
  getTerminalInputOverride,
  handleTerminalInputOverride,
  handleTerminalKeyEvent,
} from '../src/lib/terminal-keyboard'

function makeKeyEvent(
  overrides: Partial<KeyboardEvent> & { type?: string } = {}
): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: '',
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    stopPropagation: vi.fn(),
    type: 'keydown',
    ...overrides,
  } as unknown as KeyboardEvent
}

describe('terminal input overrides', () => {
  it('sends Ctrl+B as Emacs backward-character input', () => {
    expect(
      getTerminalInputOverride(makeKeyEvent({ ctrlKey: true, key: 'b' }), true)
    ).toBe('\x02')
  })

  it('sends macOS Ctrl+F as Emacs forward-character input', () => {
    expect(
      getTerminalInputOverride(makeKeyEvent({ ctrlKey: true, key: 'f' }), true)
    ).toBe('\x06')
  })

  it('preserves non-macOS Ctrl+F for terminal find handling', () => {
    expect(
      getTerminalInputOverride(makeKeyEvent({ ctrlKey: true, key: 'f' }), false)
    ).toBeUndefined()
  })

  it('maps macOS Option+Left to Meta+B instead of a modified-arrow CSI sequence', () => {
    expect(
      getTerminalInputOverride(
        makeKeyEvent({ altKey: true, key: 'ArrowLeft' }),
        true
      )
    ).toBe('\x1bb')
  })

  it('maps macOS Option+Right to Meta+F instead of a modified-arrow CSI sequence', () => {
    expect(
      getTerminalInputOverride(
        makeKeyEvent({ altKey: true, key: 'ArrowRight' }),
        true
      )
    ).toBe('\x1bf')
  })

  it('maps macOS Cmd+Left to Ctrl+A beginning-of-line input', () => {
    expect(
      getTerminalInputOverride(
        makeKeyEvent({ key: 'ArrowLeft', metaKey: true }),
        true
      )
    ).toBe('\x01')
  })

  it('maps macOS Cmd+Right to Ctrl+E end-of-line input', () => {
    expect(
      getTerminalInputOverride(
        makeKeyEvent({ key: 'ArrowRight', metaKey: true }),
        true
      )
    ).toBe('\x05')
  })

  it('does not translate Option+Arrow on other platforms', () => {
    expect(
      getTerminalInputOverride(
        makeKeyEvent({ altKey: true, key: 'ArrowRight' }),
        false
      )
    ).toBeUndefined()
  })

  it.each([
    { altKey: true, ctrlKey: true, key: 'b' },
    { ctrlKey: true, key: 'b', metaKey: true },
    { ctrlKey: true, key: 'b', shiftKey: true },
    { altKey: true, key: 'ArrowLeft', metaKey: true },
    { altKey: true, key: 'ArrowRight', shiftKey: true },
    { key: 'ArrowLeft', metaKey: true, shiftKey: true },
  ])('does not translate extra-modifier input: %o', (modifiers) => {
    expect(
      getTerminalInputOverride(makeKeyEvent(modifiers), true)
    ).toBeUndefined()
  })

  it('does not translate keyup events', () => {
    expect(
      getTerminalInputOverride(
        makeKeyEvent({ altKey: true, key: 'ArrowRight', type: 'keyup' }),
        true
      )
    ).toBeUndefined()
  })

  it('consumes an override and sends it once while the terminal is running', () => {
    const event = makeKeyEvent({ altKey: true, key: 'ArrowRight' })
    const send = vi.fn()

    expect(handleTerminalInputOverride(event, true, send, true)).toBe(true)
    expect(send).toHaveBeenCalledExactlyOnceWith('\x1bf')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('consumes an override without sending while the terminal is stopped', () => {
    const event = makeKeyEvent({ altKey: true, key: 'ArrowRight' })
    const send = vi.fn()

    expect(handleTerminalInputOverride(event, false, send, true)).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
  })

  it('does not consume normal terminal input', () => {
    const event = makeKeyEvent({ key: 'a' })
    const send = vi.fn()

    expect(handleTerminalInputOverride(event, true, send, true)).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  })

  it('gives Ctrl+B to the PTY before the app prefix shortcut', () => {
    const event = makeKeyEvent({ ctrlKey: true, key: 'b' })
    const send = vi.fn()
    const shouldBypass = vi.fn(() => true)
    const handleTerminalLocalShortcut = vi.fn(() => false)

    expect(
      handleTerminalKeyEvent(
        event,
        {
          handleTerminalLocalShortcut,
          isRunning: true,
          send,
          shouldBypass,
        },
        true
      )
    ).toBe(false)
    expect(send).toHaveBeenCalledExactlyOnceWith('\x02')
    expect(shouldBypass).not.toHaveBeenCalled()
    expect(handleTerminalLocalShortcut).not.toHaveBeenCalled()
  })

  it('gives macOS Ctrl+F to the PTY before terminal find', () => {
    const event = makeKeyEvent({ ctrlKey: true, key: 'f' })
    const send = vi.fn()
    const shouldBypass = vi.fn(() => false)
    const handleTerminalLocalShortcut = vi.fn(() => true)

    expect(
      handleTerminalKeyEvent(
        event,
        {
          handleTerminalLocalShortcut,
          isRunning: true,
          send,
          shouldBypass,
        },
        true
      )
    ).toBe(false)
    expect(send).toHaveBeenCalledExactlyOnceWith('\x06')
    expect(shouldBypass).not.toHaveBeenCalled()
    expect(handleTerminalLocalShortcut).not.toHaveBeenCalled()
  })

  it('still bypasses Cmd+Option+Arrow for pane navigation', () => {
    const event = makeKeyEvent({
      altKey: true,
      key: 'ArrowLeft',
      metaKey: true,
    })
    const send = vi.fn()
    const shouldBypass = vi.fn(() => true)

    expect(
      handleTerminalKeyEvent(
        event,
        {
          handleTerminalLocalShortcut: vi.fn(() => false),
          isRunning: true,
          send,
          shouldBypass,
        },
        true
      )
    ).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(shouldBypass).toHaveBeenCalledExactlyOnceWith(event)
  })
})
