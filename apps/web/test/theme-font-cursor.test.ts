/**
 * Tests for Issue 3: Theme, font, and cursor configuration.
 *
 * Verifies that:
 * 1. ghostty-web's ITerminalOptions and ITheme interfaces accept the full
 *    zinc color scale, JetBrains Mono font, cursor settings, and scrollback
 * 2. terminal-pane.tsx applies the correct visual configuration
 * 3. The contenteditable caret is hidden (caretColor: transparent)
 * 4. All 16 ANSI colors are mapped to the zinc-based palette
 * 5. ghostty-web does not support lineHeight (confirmed gap, not a bug)
 *
 * Note: WASM-dependent rendering tests (verifying actual canvas pixels) cannot
 * run in jsdom. Visual correctness is verified in e2e tests and manual QA.
 * These tests verify API compatibility and code-level integration patterns.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const terminalPanePath = path.resolve(
  import.meta.dirname,
  '../src/panes/terminal-pane.tsx'
)
const terminalPaneContent = fs.readFileSync(terminalPanePath, 'utf-8')

/** Read ghostty-web type definitions once for all API compatibility tests. */
const dtsPath = path.resolve(
  import.meta.dirname,
  '../node_modules/ghostty-web/dist/index.d.ts'
)
const dtsContent = fs.readFileSync(dtsPath, 'utf-8')

/** Extract ITerminalOptions and ITheme blocks from type definitions. */
const TERMINAL_OPTIONS_MATCH = dtsContent.match(
  /interface ITerminalOptions \{[\s\S]*?\n\}/
)
const TERMINAL_OPTIONS_BLOCK = TERMINAL_OPTIONS_MATCH?.[0] ?? ''

const THEME_INTERFACE_MATCH = dtsContent.match(
  /interface ITheme \{[\s\S]*?\n\}/
)
const THEME_INTERFACE_BLOCK = THEME_INTERFACE_MATCH?.[0] ?? ''

/** Extract the Terminal constructor call from terminal-pane.tsx. */
const TERMINAL_CONSTRUCTOR_MATCH = terminalPaneContent.match(
  /new Terminal\(\{[\s\S]*?\}\)/
)
const TERMINAL_CONSTRUCTOR_BLOCK = TERMINAL_CONSTRUCTOR_MATCH?.[0] ?? ''

/** Extract the theme block from terminal-pane.tsx. */
const THEME_BLOCK_MATCH = terminalPaneContent.match(/theme:\s*\{[\s\S]*?\}/)
const THEME_BLOCK = THEME_BLOCK_MATCH?.[0] ?? ''

/**
 * The exact theme configuration expected in terminal-pane.tsx.
 * These values form the zinc color scale used across the application.
 */
const EXPECTED_THEME = {
  background: '#09090b',
  foreground: '#fafafa',
  cursor: '#fafafa',
  cursorAccent: '#09090b',
  selectionBackground: '#27272a80',
  black: '#09090b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#fafafa',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
} as const

/** Regex patterns hoisted to top level for biome lint/performance. */
const CURSOR_BLINK_RE = /cursorBlink:\s*true/
const CURSOR_STYLE_RE = /cursorStyle:\s*'bar'/
const FONT_FAMILY_RE =
  /fontFamily:\s*\n?\s*['"](JetBrains Mono|"JetBrains Mono")/
const FONT_SIZE_RE = /fontSize:\s*13/
const SCROLLBACK_RE = /scrollback:\s*100[_,]000/
const CARET_COLOR_RE = /caretColor.*transparent/
const CONVERT_EOL_RE = /convertEol:\s*false/
const LINE_HEIGHT_RE = /lineHeight/
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/

describe('Issue 3: Theme, font, and cursor configuration', () => {
  describe('ghostty-web ITerminalOptions API compatibility', () => {
    it('ITerminalOptions accepts cursorBlink boolean', () => {
      expect(TERMINAL_OPTIONS_BLOCK).toContain('cursorBlink?:')
    })

    it('ITerminalOptions accepts cursorStyle with bar value', () => {
      expect(TERMINAL_OPTIONS_BLOCK).toContain('cursorStyle?:')
      expect(TERMINAL_OPTIONS_BLOCK).toContain("'bar'")
    })

    it('ITerminalOptions accepts fontSize number', () => {
      expect(TERMINAL_OPTIONS_BLOCK).toContain('fontSize?:')
    })

    it('ITerminalOptions accepts fontFamily string', () => {
      expect(TERMINAL_OPTIONS_BLOCK).toContain('fontFamily?:')
    })

    it('ITerminalOptions accepts scrollback number', () => {
      expect(TERMINAL_OPTIONS_BLOCK).toContain('scrollback?:')
    })

    it('ITerminalOptions accepts theme with ITheme interface', () => {
      expect(TERMINAL_OPTIONS_BLOCK).toContain('theme?:')
    })

    it('ghostty-web does not support lineHeight option', () => {
      // Confirmed: ghostty-web's ITerminalOptions has no lineHeight property.
      // Cell height is computed automatically from FontMetrics based on
      // fontSize and fontFamily. This is an accepted gap in the migration.
      expect(TERMINAL_OPTIONS_BLOCK).not.toContain('lineHeight')
      // Sanity check: fontSize IS there
      expect(TERMINAL_OPTIONS_BLOCK).toContain('fontSize')
    })
  })

  describe('ghostty-web ITheme API compatibility', () => {
    it('ITheme supports all 16 ANSI color properties', () => {
      // 8 normal ANSI colors
      for (const color of [
        'black',
        'red',
        'green',
        'yellow',
        'blue',
        'magenta',
        'cyan',
        'white',
      ]) {
        expect(THEME_INTERFACE_BLOCK).toContain(`${color}?:`)
      }

      // 8 bright ANSI colors
      for (const color of [
        'brightBlack',
        'brightRed',
        'brightGreen',
        'brightYellow',
        'brightBlue',
        'brightMagenta',
        'brightCyan',
        'brightWhite',
      ]) {
        expect(THEME_INTERFACE_BLOCK).toContain(`${color}?:`)
      }
    })

    it('ITheme supports foreground and background', () => {
      expect(THEME_INTERFACE_BLOCK).toContain('foreground?:')
      expect(THEME_INTERFACE_BLOCK).toContain('background?:')
    })

    it('ITheme supports cursor and cursorAccent', () => {
      expect(THEME_INTERFACE_BLOCK).toContain('cursor?:')
      expect(THEME_INTERFACE_BLOCK).toContain('cursorAccent?:')
    })

    it('ITheme supports selectionBackground and selectionForeground', () => {
      expect(THEME_INTERFACE_BLOCK).toContain('selectionBackground?:')
      expect(THEME_INTERFACE_BLOCK).toContain('selectionForeground?:')
    })
  })

  describe('terminal-pane.tsx theme configuration', () => {
    it('sets background to zinc-950 (#09090b)', () => {
      expect(terminalPaneContent).toContain(
        `background: '${EXPECTED_THEME.background}'`
      )
    })

    it('sets foreground to zinc-50 (#fafafa)', () => {
      expect(terminalPaneContent).toContain(
        `foreground: '${EXPECTED_THEME.foreground}'`
      )
    })

    it('sets cursor color to zinc-50 (#fafafa)', () => {
      expect(terminalPaneContent).toContain(
        `cursor: '${EXPECTED_THEME.cursor}'`
      )
    })

    it('sets cursorAccent to zinc-950 (#09090b)', () => {
      expect(terminalPaneContent).toContain(
        `cursorAccent: '${EXPECTED_THEME.cursorAccent}'`
      )
    })

    it('sets selectionBackground to zinc-800 with alpha (#27272a80)', () => {
      expect(terminalPaneContent).toContain(
        `selectionBackground: '${EXPECTED_THEME.selectionBackground}'`
      )
    })

    it('configures all 8 normal ANSI colors', () => {
      expect(terminalPaneContent).toContain(`black: '${EXPECTED_THEME.black}'`)
      expect(terminalPaneContent).toContain(`red: '${EXPECTED_THEME.red}'`)
      expect(terminalPaneContent).toContain(`green: '${EXPECTED_THEME.green}'`)
      expect(terminalPaneContent).toContain(
        `yellow: '${EXPECTED_THEME.yellow}'`
      )
      expect(terminalPaneContent).toContain(`blue: '${EXPECTED_THEME.blue}'`)
      expect(terminalPaneContent).toContain(
        `magenta: '${EXPECTED_THEME.magenta}'`
      )
      expect(terminalPaneContent).toContain(`cyan: '${EXPECTED_THEME.cyan}'`)
      expect(terminalPaneContent).toContain(`white: '${EXPECTED_THEME.white}'`)
    })

    it('configures all 8 bright ANSI colors', () => {
      expect(terminalPaneContent).toContain(
        `brightBlack: '${EXPECTED_THEME.brightBlack}'`
      )
      expect(terminalPaneContent).toContain(
        `brightRed: '${EXPECTED_THEME.brightRed}'`
      )
      expect(terminalPaneContent).toContain(
        `brightGreen: '${EXPECTED_THEME.brightGreen}'`
      )
      expect(terminalPaneContent).toContain(
        `brightYellow: '${EXPECTED_THEME.brightYellow}'`
      )
      expect(terminalPaneContent).toContain(
        `brightBlue: '${EXPECTED_THEME.brightBlue}'`
      )
      expect(terminalPaneContent).toContain(
        `brightMagenta: '${EXPECTED_THEME.brightMagenta}'`
      )
      expect(terminalPaneContent).toContain(
        `brightCyan: '${EXPECTED_THEME.brightCyan}'`
      )
      expect(terminalPaneContent).toContain(
        `brightWhite: '${EXPECTED_THEME.brightWhite}'`
      )
    })
  })

  describe('terminal-pane.tsx cursor configuration', () => {
    it('enables cursor blink', () => {
      expect(terminalPaneContent).toMatch(CURSOR_BLINK_RE)
    })

    it('sets cursor style to bar', () => {
      expect(terminalPaneContent).toMatch(CURSOR_STYLE_RE)
    })
  })

  describe('terminal-pane.tsx font configuration', () => {
    it('uses JetBrains Mono as primary font', () => {
      expect(terminalPaneContent).toMatch(FONT_FAMILY_RE)
    })

    it('includes fallback fonts (Fira Code, Cascadia Code, Menlo)', () => {
      expect(terminalPaneContent).toContain('Fira Code')
      expect(terminalPaneContent).toContain('Cascadia Code')
      expect(terminalPaneContent).toContain('Menlo')
    })

    it('sets font size to 13px', () => {
      expect(terminalPaneContent).toMatch(FONT_SIZE_RE)
    })

    it('does not set lineHeight (not supported by ghostty-web)', () => {
      // The Terminal constructor in terminal-pane.tsx should not contain lineHeight.
      // ghostty-web computes cell height from FontMetrics automatically.
      expect(TERMINAL_CONSTRUCTOR_BLOCK).not.toMatch(LINE_HEIGHT_RE)
    })
  })

  describe('terminal-pane.tsx scrollback configuration', () => {
    it('configures scrollback to 100,000 lines', () => {
      expect(terminalPaneContent).toMatch(SCROLLBACK_RE)
    })

    it('sets convertEol to false', () => {
      expect(terminalPaneContent).toMatch(CONVERT_EOL_RE)
    })
  })

  describe('terminal-pane.tsx contenteditable caret hiding', () => {
    it('sets caretColor to transparent on the container', () => {
      expect(terminalPaneContent).toMatch(CARET_COLOR_RE)
    })

    it('caret hiding is applied before terminal.open()', () => {
      const caretPos = terminalPaneContent.indexOf('caretColor')
      const openPos = terminalPaneContent.indexOf('terminal.open(container)')
      expect(caretPos).toBeGreaterThan(-1)
      expect(openPos).toBeGreaterThan(-1)
      expect(caretPos).toBeLessThan(openPos)
    })
  })

  describe('theme completeness', () => {
    it('theme block contains all expected color keys', () => {
      expect(THEME_BLOCK_MATCH).not.toBeNull()

      // Every key in EXPECTED_THEME should appear in the theme block
      for (const key of Object.keys(EXPECTED_THEME)) {
        expect(THEME_BLOCK).toContain(`${key}:`)
      }
    })

    it('all theme color values are valid CSS hex colors', () => {
      for (const [key, value] of Object.entries(EXPECTED_THEME)) {
        expect(
          HEX_COLOR_RE.test(value),
          `${key}: "${value}" should be a valid hex color`
        ).toBe(true)
      }
    })
  })
})
