import { describe, expect, it } from 'vitest'

import {
  splitByUtf8Bytes,
  TerminalCursorJournal,
  utf8Bytes,
} from '../src/services/terminal-transport.js'

describe('terminal cursor transport', () => {
  it('chunks by encoded bytes without splitting code points', () => {
    const chunks = splitByUtf8Bytes('ab😀cd', 4)
    expect(chunks).toEqual(['ab', '😀', 'cd'])
    expect(chunks.every((chunk) => utf8Bytes(chunk) <= 4)).toBe(true)
  })

  it('uses absolute byte cursors and explicitly identifies pruned cursors', () => {
    const journal = new TerminalCursorJournal(6)
    const first = journal.append('abc')
    const second = journal.append('😀')

    expect(first).toBe(3)
    expect(second).toBe(7)
    expect(journal.minimumCursor).toBe(3)
    expect(journal.retains(0)).toBe(false)
    expect(journal.deltasAfter(3)).toEqual([
      { _tag: 'Delta', cursor: 7, data: '😀' },
    ])
  })

  it('keeps replay storage within its byte budget', () => {
    const journal = new TerminalCursorJournal(8)
    for (const chunk of ['1234', '5678', '90ab']) {
      journal.append(chunk)
    }
    expect(journal.bytes).toBeLessThanOrEqual(8)
    expect(journal.cursor).toBe(12)
    expect(journal.minimumCursor).toBe(4)
  })
})
