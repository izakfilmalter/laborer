/**
 * The screen text terminal find is built on, read from the real Ghostty WASM.
 *
 * Find maps a line index to a screen row and a character index to a column, so
 * the formatter has to emit exactly one line per row, keep soft-wrapped rows
 * apart, and leave the user's own selection alone. All three are properties of
 * the vendored artifact rather than of our code, so they are pinned here.
 *
 * @see apps/web/src/terminal/ghostty/core.ts — `screenLines`
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  GhosttyTerminalCore,
  type GhosttyTheme,
} from '../src/terminal/ghostty/core'

const THEME: GhosttyTheme = {
  background: { r: 0, g: 0, b: 0 },
  cursor: { r: 255, g: 255, b: 255 },
  foreground: { r: 255, g: 255, b: 255 },
}

const COLS = 20
const ROWS = 4

let core: GhosttyTerminalCore | null = null

/**
 * The runtime loads its artifacts over `fetch`, which jsdom has nothing behind.
 * Reading the vendored files off disk keeps the test offline and deterministic
 * while still exercising the real WASM.
 */
beforeAll(() => {
  const vendor = path.resolve(
    import.meta.dirname,
    '../src/terminal/ghostty/vendor'
  )
  globalThis.fetch = ((url: string) => {
    const name = path.basename(String(url).split('?')[0] ?? '')
    const bytes = readFileSync(path.join(vendor, name))
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () =>
        Promise.resolve(
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength
          )
        ),
    })
  }) as typeof fetch
})

afterEach(() => {
  core?.dispose()
  core = null
})

async function writtenTerminal(data: string): Promise<GhosttyTerminalCore> {
  const created = await GhosttyTerminalCore.create(
    COLS,
    ROWS,
    8,
    16,
    THEME,
    () => undefined
  )
  core = created
  created.write(data)
  return created
}

describe('GhosttyTerminalCore.screenLines', () => {
  it('emits one line per screen row, scrollback first', async () => {
    const terminal = await writtenTerminal(
      'alpha\r\nbravo\r\ncharlie\r\ndelta\r\necho\r\n'
    )
    expect(terminal.screenLines()).toEqual({
      firstRow: 0,
      lines: ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
    })
  })

  it('keeps a soft-wrapped row on its own line, so columns stay cell columns', async () => {
    const terminal = await writtenTerminal(
      'wrapped line that is longer than the grid\r\n'
    )
    const { lines } = terminal.screenLines()
    expect(lines[0]).toBe('wrapped line that is')
    expect(lines[1]?.startsWith(' longer than the')).toBe(true)
    expect(lines.every((line) => line.length <= COLS)).toBe(true)
  })

  it('reads the screen without disturbing the terminal selection', async () => {
    const terminal = await writtenTerminal('alpha\r\nbravo\r\n')
    terminal.setSelection({ x: 0, y: 0, tag: 2 }, { x: 4, y: 0, tag: 2 })
    terminal.screenLines()
    expect(terminal.selectionText()).toBe('alpha')
  })
})
