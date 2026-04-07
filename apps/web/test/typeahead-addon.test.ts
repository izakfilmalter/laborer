/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Adapted for laborer from VS Code's terminalTypeAhead.test.ts.
 *  Original: src/vs/workbench/contrib/terminalContrib/typeAhead/test/browser/terminalTypeAhead.test.ts
 *--------------------------------------------------------------------------------------------*/

import type { IBuffer, IDisposable, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  IBeforeProcessDataEvent,
  IPrediction,
  ITypeAheadProcessManager,
} from '../src/lib/typeahead-addon'
import {
  CharPredictState,
  Emitter,
  PredictionStats,
  type PredictionTimeline,
  TypeAheadAddon,
} from '../src/lib/typeahead-addon'

const CSI = '\x1b['

const CursorMoveDirection = {
  Back: 'D',
  Forwards: 'C',
} as const

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class TestTypeAheadAddon extends TypeAheadAddon {
  unlockMakingPredictions() {
    this._lastRow = {
      y: 1,
      startingX: 100,
      endingX: 100,
      charState: CharPredictState.Validated,
    }
  }

  lockMakingPredictions() {
    this._lastRow = undefined
  }

  unlockNavigating() {
    this._lastRow = {
      y: 1,
      startingX: 1,
      endingX: 1,
      charState: CharPredictState.Validated,
    }
  }

  reevaluateNow() {
    if (this.stats && this._timeline) {
      this._reevaluatePredictorStateNow(this.stats, this._timeline)
    }
  }

  get isShowing() {
    return !!this._timeline?.isShowingPredictions
  }

  undoAllPredictions() {
    this._timeline?.undoAllPredictions()
  }

  physicalCursor(buffer: IBuffer) {
    return this._timeline?.physicalCursor(buffer)
  }

  tentativeCursor(buffer: IBuffer) {
    return this._timeline?.tentativeCursor(buffer)
  }
}

function createPredictionStubs(n: number) {
  return new Array(n).fill(0).map(stubPrediction)
}

function stubPrediction(): IPrediction {
  return {
    apply: () => '',
    rollback: () => '',
    matches: () => 0,
    rollForwards: () => '',
  }
}

function createMockTerminal({
  lines,
  cursorAttrs,
}: {
  lines: string[]
  cursorAttrs?: Record<string, unknown>
}) {
  const disposables: IDisposable[] = []
  const written: string[] = []
  const cursor = { y: 1, x: 1 }
  const onTitleChange = new Emitter<string>()
  disposables.push(onTitleChange)
  const onData = new Emitter<string>()
  disposables.push(onData)
  const csiEmitter = new Emitter<number[]>()
  disposables.push(csiEmitter)

  for (let y = 0; y < lines.length; y++) {
    const line = lines[y]
    if (line?.includes('|')) {
      cursor.y = y + 1
      cursor.x = line.indexOf('|') + 1
      lines[y] = line.replace('|', '') // replacing the first occurrence is intended
      break
    }
  }

  return {
    written,
    cursor,
    expectWritten: (s: string) => {
      // biome-ignore lint/suspicious/noMisplacedAssertion: helper function only called from within it() blocks
      expect(JSON.stringify(written.join(''))).toBe(JSON.stringify(s))
      written.splice(0, written.length)
    },
    clearWritten: () => written.splice(0, written.length),
    onData: (s: string) => onData.fire(s),
    csiEmitter,
    onTitleChange,
    dispose: () => {
      for (const d of disposables) {
        d.dispose()
      }
    },
    terminal: {
      cols: 80,
      rows: 5,
      onResize: new Emitter<void>().event,
      onData: onData.event,
      onTitleChange: onTitleChange.event,
      parser: {
        registerCsiHandler(_: unknown, callback: () => void) {
          disposables.push(csiEmitter.event(callback))
        },
      },
      write(line: string) {
        written.push(line)
      },
      _core: {
        _inputHandler: {
          _curAttrData: mockCell('', cursorAttrs),
        },
        writeSync() {
          // no-op
        },
      },
      buffer: {
        active: {
          type: 'normal',
          baseY: 0,
          get cursorY() {
            return cursor.y
          },
          get cursorX() {
            return cursor.x
          },
          getLine(y: number) {
            const s = lines[y - 1] || ''
            return {
              length: s.length,
              getCell: (x: number) => mockCell(s[x - 1] || ''),
              translateToString: (trim: boolean, start = 0, end = s.length) => {
                const out = s.slice(start, end)
                return trim ? out.trimEnd() : out
              },
            }
          },
        },
      },
    } as unknown as Terminal,
  }
}

function mockCell(
  char: string,
  attrs: Record<string, unknown> = {}
): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (typeof prop === 'string' && prop in attrs) {
          return () => attrs[prop]
        }

        switch (prop) {
          case 'getWidth':
            return () => 1
          case 'getChars':
            return () => char
          case 'getCode':
            return () => char.charCodeAt(0) || 0
          case 'isAttributeDefault':
            return () => true
          default:
            return String(prop).startsWith('is') ? () => false : () => 0
        }
      },
    }
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Terminal Typeahead', () => {
  describe('PredictionStats', () => {
    let stats: PredictionStats
    let add: Emitter<IPrediction>
    let succeed: Emitter<IPrediction>
    let fail: Emitter<IPrediction>

    beforeEach(() => {
      add = new Emitter<IPrediction>()
      succeed = new Emitter<IPrediction>()
      fail = new Emitter<IPrediction>()

      stats = new PredictionStats({
        onPredictionAdded: add.event,
        onPredictionSucceeded: succeed.event,
        onPredictionFailed: fail.event,
      } as unknown as PredictionTimeline)
    })

    afterEach(() => {
      stats.dispose()
      add.dispose()
      succeed.dispose()
      fail.dispose()
    })

    it('creates sane data', () => {
      vi.useFakeTimers()
      try {
        const stubs = createPredictionStubs(5)
        for (const s of stubs) {
          add.fire(s)
        }

        for (let i = 0; i < stubs.length; i++) {
          vi.advanceTimersByTime(100)
          const stub = stubs[i]
          if (stub) {
            ;(i % 2 ? fail : succeed).fire(stub)
          }
        }

        expect(stats.accuracy).toBe(3 / 5)
        expect(stats.sampleSize).toBe(5)
        expect(stats.latency).toStrictEqual({
          count: 3,
          min: 100,
          max: 500,
          median: 300,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('circular buffer', () => {
      const bufferSize = 24
      const stubs = createPredictionStubs(bufferSize * 2)

      for (const s of stubs.slice(0, bufferSize)) {
        add.fire(s)
        succeed.fire(s)
      }
      expect(stats.accuracy).toBe(1)

      for (const s of stubs.slice(bufferSize, (bufferSize * 3) / 2)) {
        add.fire(s)
        fail.fire(s)
      }
      expect(stats.accuracy).toBe(0.5)

      for (const s of stubs.slice((bufferSize * 3) / 2)) {
        add.fire(s)
        fail.fire(s)
      }
      expect(stats.accuracy).toBe(0)
    })
  })

  describe('timeline', () => {
    let onBeforeProcessData: Emitter<IBeforeProcessDataEvent>
    let addon: TestTypeAheadAddon

    const predictedHelloo = [
      `${CSI}?25l`, // hide cursor
      `${CSI}2;7H`, // move cursor
      'o', // new character
      `${CSI}2;8H`, // place cursor back at end of line
      `${CSI}?25h`, // show cursor
    ].join('')

    beforeEach(() => {
      onBeforeProcessData = new Emitter<IBeforeProcessDataEvent>()
      addon = new TestTypeAheadAddon(
        {
          onBeforeProcessData: onBeforeProcessData.event,
        } as ITypeAheadProcessManager,
        {
          latencyThreshold: 0,
          style: 'italic',
          excludePrograms: ['vim', 'vi', 'nano', 'tmux'],
        }
      )
      addon.unlockMakingPredictions()
    })

    afterEach(() => {
      addon.dispose()
      onBeforeProcessData.dispose()
    })

    /** Fire onBeforeProcessData and assert the mutated event.data */
    const expectProcessed = (input: string, output: string) => {
      const evt = { data: input }
      onBeforeProcessData.fire(evt)
      return { actual: evt.data, expected: output }
    }

    it('predicts a single character', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('o')
        t.expectWritten(`${CSI}3mo${CSI}23m`)
      } finally {
        t.dispose()
      }
    })

    it('validates character prediction', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('o')
        const r = expectProcessed('o', predictedHelloo)
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(1)
      } finally {
        t.dispose()
      }
    })

    it('validates zsh prediction (#112842)', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('o')
        const r1 = expectProcessed('o', predictedHelloo)
        expect(JSON.stringify(r1.actual)).toBe(JSON.stringify(r1.expected))

        t.onData('x')
        const expectedOutput = [
          `${CSI}?25l`, // hide cursor
          `${CSI}2;8H`, // move cursor
          '\box', // new data
          `${CSI}2;9H`, // place cursor back at end of line
          `${CSI}?25h`, // show cursor
        ].join('')
        const r2 = expectProcessed('\box', expectedOutput)
        expect(JSON.stringify(r2.actual)).toBe(JSON.stringify(r2.expected))
        expect(addon.stats?.accuracy).toBe(1)
      } finally {
        t.dispose()
      }
    })

    it('does not validate zsh prediction on differing lookbehind (#112842)', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('o')
        const r1 = expectProcessed('o', predictedHelloo)
        expect(JSON.stringify(r1.actual)).toBe(JSON.stringify(r1.expected))

        t.onData('x')
        const expectedOutput = [
          `${CSI}?25l`, // hide cursor
          `${CSI}2;8H`, // move cursor
          `${CSI}X`, // delete character
          `${CSI}0m`, // reset style
          '\bqx', // new data
          `${CSI}?25h`, // show cursor
        ].join('')
        const r2 = expectProcessed('\bqx', expectedOutput)
        expect(JSON.stringify(r2.actual)).toBe(JSON.stringify(r2.expected))
        expect(addon.stats?.accuracy).toBe(0.5)
      } finally {
        t.dispose()
      }
    })

    it('rolls back character prediction', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('o')

        const expectedOutput = [
          `${CSI}?25l`, // hide cursor
          `${CSI}2;7H`, // move cursor
          `${CSI}X`, // delete character
          `${CSI}0m`, // reset style
          'q', // new character
          `${CSI}?25h`, // show cursor
        ].join('')
        const r = expectProcessed('q', expectedOutput)
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(0)
      } finally {
        t.dispose()
      }
    })

    it('handles left arrow when we hit the boundary', () => {
      const t = createMockTerminal({ lines: ['|'] })
      try {
        addon.activate(t.terminal)
        addon.unlockNavigating()

        const cursorXBefore =
          addon.physicalCursor(t.terminal.buffer.active)?.x ?? 0
        t.onData(`${CSI}${CursorMoveDirection.Back}`)
        t.expectWritten('')

        // Trigger rollback because we don't expect this data
        onBeforeProcessData.fire({ data: 'xy' })

        expect(addon.physicalCursor(t.terminal.buffer.active)?.x).toBe(
          // The cursor should not have changed because we've hit the
          // boundary (start of prompt)
          cursorXBefore
        )
      } finally {
        t.dispose()
      }
    })

    it('handles right arrow when we hit the boundary', () => {
      const t = createMockTerminal({ lines: ['|'] })
      try {
        addon.activate(t.terminal)
        addon.unlockNavigating()

        const cursorXBefore =
          addon.physicalCursor(t.terminal.buffer.active)?.x ?? 0
        t.onData(`${CSI}${CursorMoveDirection.Forwards}`)
        t.expectWritten('')

        // Trigger rollback because we don't expect this data
        onBeforeProcessData.fire({ data: 'xy' })

        expect(addon.physicalCursor(t.terminal.buffer.active)?.x).toBe(
          // The cursor should not have changed because we've hit the
          // boundary (end of prompt)
          cursorXBefore
        )
      } finally {
        t.dispose()
      }
    })

    it('internal cursor state is reset when all predictions are undone', () => {
      const t = createMockTerminal({ lines: ['|'] })
      try {
        addon.activate(t.terminal)
        addon.unlockNavigating()

        const cursorXBefore =
          addon.physicalCursor(t.terminal.buffer.active)?.x ?? 0
        t.onData(`${CSI}${CursorMoveDirection.Back}`)
        t.expectWritten('')
        addon.undoAllPredictions()

        expect(addon.physicalCursor(t.terminal.buffer.active)?.x).toBe(
          // The cursor should not have changed because we've hit the
          // boundary (start of prompt)
          cursorXBefore
        )
      } finally {
        t.dispose()
      }
    })

    it('restores cursor graphics mode', () => {
      const t = createMockTerminal({
        lines: ['hello|'],
        cursorAttrs: {
          isAttributeDefault: false,
          isBold: true,
          isFgPalette: true,
          getFgColor: 1,
        },
      })
      try {
        addon.activate(t.terminal)
        t.onData('o')

        const expectedOutput = [
          `${CSI}?25l`, // hide cursor
          `${CSI}2;7H`, // move cursor
          `${CSI}X`, // delete character
          `${CSI}1;38;5;1m`, // reset style
          'q', // new character
          `${CSI}?25h`, // show cursor
        ].join('')
        const r = expectProcessed('q', expectedOutput)
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(0)
      } finally {
        t.dispose()
      }
    })

    it('validates against and applies graphics mode on predicted', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('o')
        const expectedOutput = [
          `${CSI}?25l`, // hide cursor
          `${CSI}2;7H`, // move cursor
          `${CSI}4m`, // new PTY's style
          'o', // new character
          `${CSI}2;8H`, // place cursor back at end of line
          `${CSI}?25h`, // show cursor
        ].join('')
        const r = expectProcessed(`${CSI}4mo`, expectedOutput)
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(1)
      } finally {
        t.dispose()
      }
    })

    it('ignores cursor hides or shows', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('o')
        const expectedOutput = [
          `${CSI}?25l`, // hide cursor from PTY
          `${CSI}?25l`, // hide cursor
          `${CSI}2;7H`, // move cursor
          'o', // new character
          `${CSI}?25h`, // show cursor from PTY
          `${CSI}2;8H`, // place cursor back at end of line
          `${CSI}?25h`, // show cursor
        ].join('')
        const r = expectProcessed(`${CSI}?25lo${CSI}?25h`, expectedOutput)
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(1)
      } finally {
        t.dispose()
      }
    })

    it('matches backspace at EOL (bash style)', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('\x7F')
        const r = expectProcessed(`\b${CSI}K`, `\b${CSI}K`)
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(1)
      } finally {
        t.dispose()
      }
    })

    it('matches backspace at EOL (zsh style)', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('\x7F')
        const r = expectProcessed('\b \b', '\b \b')
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(1)
      } finally {
        t.dispose()
      }
    })

    it('gradually matches backspace', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)
        t.onData('\x7F')
        const r1 = expectProcessed('\b', '')
        expect(JSON.stringify(r1.actual)).toBe(JSON.stringify(r1.expected))
        const r2 = expectProcessed(' \b', '\b \b')
        expect(JSON.stringify(r2.actual)).toBe(JSON.stringify(r2.expected))
        expect(addon.stats?.accuracy).toBe(1)
      } finally {
        t.dispose()
      }
    })

    it('restores old character after invalid backspace', () => {
      const t = createMockTerminal({ lines: ['hel|lo'] })
      try {
        addon.activate(t.terminal)
        addon.unlockNavigating()
        t.onData('\x7F')
        t.expectWritten(`${CSI}2;4H${CSI}X`)
        const r = expectProcessed(
          'x',
          `${CSI}?25l${CSI}0ml${CSI}2;5H${CSI}0mx${CSI}?25h`
        )
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        expect(addon.stats?.accuracy).toBe(0)
      } finally {
        t.dispose()
      }
    })

    it('waits for validation before deleting to left of cursor', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)

        // initially should not backspace (until the server confirms it)
        t.onData('\x7F')
        t.expectWritten('')
        const r = expectProcessed('\b \b', '\b \b')
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
        t.cursor.x--

        // enter input on the column...
        t.onData('o')
        onBeforeProcessData.fire({ data: 'o' })
        t.cursor.x++
        t.clearWritten()

        // now that the column is 'unlocked', we should be able to predict backspace on it
        t.onData('\x7F')
        t.expectWritten(`${CSI}2;6H${CSI}X`)
      } finally {
        t.dispose()
      }
    })

    it('waits for first valid prediction on a line', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.lockMakingPredictions()
        addon.activate(t.terminal)

        t.onData('o')
        t.expectWritten('')
        const r = expectProcessed('o', 'o')
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))

        t.onData('o')
        t.expectWritten(`${CSI}3mo${CSI}23m`)
      } finally {
        t.dispose()
      }
    })

    it('disables on title change', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.activate(t.terminal)

        addon.reevaluateNow()
        expect(addon.isShowing).toBe(true)

        t.onTitleChange.fire('foo - VIM.exe')
        addon.reevaluateNow()
        expect(addon.isShowing).toBe(false)

        t.onTitleChange.fire('foo - git.exe')
        addon.reevaluateNow()
        expect(addon.isShowing).toBe(true)
      } finally {
        t.dispose()
      }
    })

    it('adds line wrap prediction even if behind a boundary', () => {
      const t = createMockTerminal({ lines: ['hello|'] })
      try {
        addon.lockMakingPredictions()
        addon.activate(t.terminal)

        t.onData('hi'.repeat(50))
        t.expectWritten('')
        const expectedOutput = [
          `${CSI}?25l`, // hide cursor
          'hi', // this greeting characters
          ...new Array(36).fill(`${CSI}3mh${CSI}23m${CSI}3mi${CSI}23m`), // rest of the greetings that fit on this line
          `${CSI}2;81H`, // move to end of line
          `${CSI}?25h`,
        ].join('')
        const r = expectProcessed('hi', expectedOutput)
        expect(JSON.stringify(r.actual)).toBe(JSON.stringify(r.expected))
      } finally {
        t.dispose()
      }
    })
  })
})
