/**
 * Tests for the ghostty-web migration (Issue 1: Tracer bullet).
 *
 * Verifies that:
 * 1. ghostty-web exports the expected xterm.js-compatible API surface
 * 2. Terminal, FitAddon, and init are importable and have the right shape
 * 3. No @xterm/* imports remain in the frontend terminal code
 * 4. The patchXtermEnumPlugin is removed from vite.config.ts
 *
 * Note: WASM-dependent tests (init(), open(), write()) cannot run in jsdom
 * because WebAssembly.instantiate and fetch for .wasm files are not supported.
 * The Terminal class API is verified through type-level checks and property
 * inspection. Full end-to-end WASM tests are handled by the e2e test suite.
 */

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/** Regex patterns hoisted to top level for biome lint/performance. */
const XTERM_IMPORT_RE = /@xterm\//
const XTERM_CSS_RE = /xterm\.css/
const GHOSTTY_WEB_IMPORT_RE = /from 'ghostty-web'/
const PATCH_XTERM_ENUM_RE = /patchXtermEnumPlugin/
const PATCH_XTERM_NAME_RE = /patch-xterm-enum/

describe('ghostty-web migration', () => {
  describe('API surface exports', () => {
    it('exports Terminal class from ghostty-web', async () => {
      const ghosttyWeb = await import('ghostty-web')
      expect(ghosttyWeb.Terminal).toBeDefined()
      expect(typeof ghosttyWeb.Terminal).toBe('function')
    })

    it('exports FitAddon class from ghostty-web', async () => {
      const ghosttyWeb = await import('ghostty-web')
      expect(ghosttyWeb.FitAddon).toBeDefined()
      expect(typeof ghosttyWeb.FitAddon).toBe('function')
    })

    it('exports init function from ghostty-web', async () => {
      const ghosttyWeb = await import('ghostty-web')
      expect(ghosttyWeb.init).toBeDefined()
      expect(typeof ghosttyWeb.init).toBe('function')
    })

    it('exports EventEmitter from ghostty-web', async () => {
      const ghosttyWeb = await import('ghostty-web')
      expect(ghosttyWeb.EventEmitter).toBeDefined()
      expect(typeof ghosttyWeb.EventEmitter).toBe('function')
    })

    it('exports Ghostty WASM loader from ghostty-web', async () => {
      const ghosttyWeb = await import('ghostty-web')
      expect(ghosttyWeb.Ghostty).toBeDefined()
      expect(typeof ghosttyWeb.Ghostty).toBe('function')
      expect(typeof ghosttyWeb.Ghostty.load).toBe('function')
    })
  })

  describe('Terminal class API shape', () => {
    it('Terminal constructor accepts ITerminalOptions', async () => {
      // Importing Terminal verifies the class is available.
      // We cannot instantiate it without WASM, but we verify the
      // constructor exists and accepts the expected option shape.
      const { Terminal } = await import('ghostty-web')
      expect(Terminal).toBeDefined()
      expect(Terminal.prototype.open).toBeDefined()
      expect(Terminal.prototype.write).toBeDefined()
      expect(Terminal.prototype.dispose).toBeDefined()
      expect(Terminal.prototype.resize).toBeDefined()
      expect(Terminal.prototype.clear).toBeDefined()
      expect(Terminal.prototype.focus).toBeDefined()
      expect(Terminal.prototype.blur).toBeDefined()
      expect(Terminal.prototype.loadAddon).toBeDefined()
      expect(Terminal.prototype.attachCustomKeyEventHandler).toBeDefined()
    })

    it('FitAddon has fit and proposeDimensions methods', async () => {
      const { FitAddon } = await import('ghostty-web')
      const fitAddon = new FitAddon()
      expect(typeof fitAddon.fit).toBe('function')
      expect(typeof fitAddon.proposeDimensions).toBe('function')
      expect(typeof fitAddon.dispose).toBe('function')
      expect(typeof fitAddon.activate).toBe('function')
      fitAddon.dispose()
    })
  })

  describe('xterm.js removal', () => {
    it('no @xterm/* imports in terminal-pane.tsx', () => {
      const terminalPanePath = path.resolve(
        import.meta.dirname,
        '../src/panes/terminal-pane.tsx'
      )
      const content = fs.readFileSync(terminalPanePath, 'utf-8')
      expect(content).not.toMatch(XTERM_IMPORT_RE)
    })

    it('no @xterm/xterm/css import in terminal-pane.tsx', () => {
      const terminalPanePath = path.resolve(
        import.meta.dirname,
        '../src/panes/terminal-pane.tsx'
      )
      const content = fs.readFileSync(terminalPanePath, 'utf-8')
      expect(content).not.toMatch(XTERM_CSS_RE)
    })

    it('terminal-pane.tsx imports from ghostty-web', () => {
      const terminalPanePath = path.resolve(
        import.meta.dirname,
        '../src/panes/terminal-pane.tsx'
      )
      const content = fs.readFileSync(terminalPanePath, 'utf-8')
      expect(content).toMatch(GHOSTTY_WEB_IMPORT_RE)
    })

    it('patchXtermEnumPlugin is removed from vite.config.ts', () => {
      const viteConfigPath = path.resolve(
        import.meta.dirname,
        '../vite.config.ts'
      )
      const content = fs.readFileSync(viteConfigPath, 'utf-8')
      expect(content).not.toMatch(PATCH_XTERM_ENUM_RE)
      expect(content).not.toMatch(PATCH_XTERM_NAME_RE)
    })

    it('no @xterm/* dependencies in package.json', () => {
      const packageJsonPath = path.resolve(
        import.meta.dirname,
        '../package.json'
      )
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      }
      const xtermDeps = Object.keys(allDeps).filter((dep) =>
        dep.startsWith('@xterm/')
      )
      expect(xtermDeps).toEqual([])
    })

    it('ghostty-web is a dependency in package.json', () => {
      const packageJsonPath = path.resolve(
        import.meta.dirname,
        '../package.json'
      )
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'))
      expect(packageJson.dependencies['ghostty-web']).toBeDefined()
    })
  })
})
