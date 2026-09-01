import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveBundledTerminalAssets } from './lib/bundled-terminal-assets.js'

const GHOSTTY_VT = 'assets/ghostty-vt-DdA0Zryv.wasm'
const GHOSTTY_WRITE_PTY = 'assets/ghostty-write-pty-hgyAvVbe.wasm'
const SYMBOLS_FONT = 'assets/SymbolsNerdFontMono-Regular-aK5vsLov.woff2'

const MISSING_VT_PATTERN = /missing terminal runtime assets: Ghostty VT runtime/
const MISSING_WRITE_PTY_PATTERN =
  /missing terminal runtime assets: Ghostty PTY writer/
const MISSING_FONT_PATTERN =
  /missing terminal runtime assets: Nerd Font symbol fallback/
const EMPTY_VT_PATTERN = /assets are empty: assets\/ghostty-vt-DdA0Zryv\.wasm/

const scratchDirs: string[] = []

afterEach(() => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) {
      rmSync(dir, { force: true, recursive: true })
    }
  }
})

/** Build a fake `apps/web/dist` containing the named files with dummy bytes. */
const makeClientDir = (files: readonly string[]): string => {
  const root = mkdtempSync(join(tmpdir(), 'laborer-terminal-assets-'))
  scratchDirs.push(root)
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html>')
  for (const file of files) {
    writeFileSync(join(root, file), 'bytes')
  }
  return root
}

describe('resolveBundledTerminalAssets', () => {
  it('resolves the content-hashed Ghostty runtime and font assets', () => {
    const root = makeClientDir([GHOSTTY_VT, GHOSTTY_WRITE_PTY, SYMBOLS_FONT])

    expect(resolveBundledTerminalAssets(root)).toEqual([
      SYMBOLS_FONT,
      GHOSTTY_VT,
      GHOSTTY_WRITE_PTY,
    ])
  })

  it('fails when the Ghostty VT module is not emitted', () => {
    const root = makeClientDir([GHOSTTY_WRITE_PTY, SYMBOLS_FONT])

    expect(() => resolveBundledTerminalAssets(root)).toThrow(MISSING_VT_PATTERN)
  })

  it('fails when the PTY writer module is inlined instead of emitted', () => {
    // `?url` without `no-inline` turns this 112-byte module into a data URL,
    // which emits no file at all.
    const root = makeClientDir([GHOSTTY_VT, SYMBOLS_FONT])

    expect(() => resolveBundledTerminalAssets(root)).toThrow(
      MISSING_WRITE_PTY_PATTERN
    )
  })

  it('fails when the Nerd Font fallback face is not emitted', () => {
    const root = makeClientDir([GHOSTTY_VT, GHOSTTY_WRITE_PTY])

    expect(() => resolveBundledTerminalAssets(root)).toThrow(
      MISSING_FONT_PATTERN
    )
  })

  it('fails when an emitted asset is empty', () => {
    const root = makeClientDir([GHOSTTY_WRITE_PTY, SYMBOLS_FONT])
    writeFileSync(join(root, GHOSTTY_VT), '')

    expect(() => resolveBundledTerminalAssets(root)).toThrow(EMPTY_VT_PATTERN)
  })
})
