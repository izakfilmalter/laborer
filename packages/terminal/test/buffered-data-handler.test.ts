/**
 * Escape sequence buffering unit tests.
 *
 * Tests the createBufferedDataHandler function that wraps raw PTY onData
 * callbacks to prevent incomplete VT escape sequences from reaching
 * subscribers.
 *
 * @see PRD-ghostty-web-migration.md — Module 1: Backend: Headless Terminal State Manager
 * @see Issue #6: Backend: Escape sequence buffering
 */

import { describe, expect, it, vi } from 'vitest'
import { createBufferedDataHandler } from '../src/lib/buffered-data-handler.js'

describe('createBufferedDataHandler', () => {
  it('forwards plain text without escape sequences immediately', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('hello')

    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('hello')
  })

  it('holds back trailing \\x1b and forwards preceding text', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('hello\x1b')

    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('hello')
  })

  it('holds back \\x1b[ entirely when it is the whole chunk', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('\x1b[')

    expect(onData).not.toHaveBeenCalled()
  })

  it('holds back incomplete CSI with parameters (\\x1b[38;5)', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('text\x1b[38;5')

    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('text')
  })

  it('flushes held-back \\x1b when next chunk completes the sequence', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('hello\x1b')
    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('hello')

    handler('[31m')
    expect(onData).toHaveBeenCalledTimes(2)
    expect(onData).toHaveBeenLastCalledWith('\x1b[31m')
  })

  it('flushes held-back \\x1b[ when next chunk completes the CSI', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('\x1b[')
    expect(onData).not.toHaveBeenCalled()

    handler('1;2H')
    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('\x1b[1;2H')
  })

  it('flushes held-back incomplete CSI params when completed', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('\x1b[38;5')
    expect(onData).not.toHaveBeenCalled()

    handler(';196m')
    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('\x1b[38;5;196m')
  })

  it('passes through chunk ending with a complete escape sequence entirely', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('hello\x1b[31mworld')

    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('hello\x1b[31mworld')
  })

  it('handles multiple consecutive chunks with accumulating incomplete sequences', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    // First chunk: bare ESC held back
    handler('\x1b')
    expect(onData).not.toHaveBeenCalled()

    // Second chunk: ESC + [ still incomplete CSI introducer
    handler('[')
    expect(onData).not.toHaveBeenCalled()

    // Third chunk: complete the sequence
    handler('32m')
    expect(onData).toHaveBeenCalledOnce()
    expect(onData).toHaveBeenCalledWith('\x1b[32m')
  })

  it('handles bare \\x1b as the only content (no preceding text)', () => {
    const onData = vi.fn()
    const handler = createBufferedDataHandler(onData)

    handler('\x1b')

    expect(onData).not.toHaveBeenCalled()
  })
})
