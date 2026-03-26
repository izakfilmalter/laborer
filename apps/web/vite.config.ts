import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/**
 * Patches xterm.js ESM to fix a Rollup tree-shaking bug with `const enum`.
 *
 * xterm.js compiles TypeScript `const enum` into runtime IIFE patterns:
 *   `let r; (P => ...)(r ||= {})`
 *
 * Rollup's tree-shaker removes the `let r;` declaration (only assigned, never
 * read) but keeps the IIFE assignment `(n = {})` in the minified output. In
 * ESM strict mode, assigning to an undeclared variable throws:
 *   `ReferenceError: Can't find variable: n`
 *
 * This plugin rewrites `(r||={})` to `(r||=(r={}))` which forces Rollup to
 * keep the declaration since `r` is now read within the expression.
 */
function patchXtermEnumPlugin() {
  return {
    name: 'patch-xterm-enum',
    transform(code: string, id: string) {
      // Only patch xterm ESM bundles — the problematic const enum IIFEs
      // only exist in the .mjs build output from xterm's TypeScript compilation.
      if (!(id.includes('@xterm') && id.endsWith('.mjs'))) {
        return
      }
      // Rewrite `(r||={})` -> `(r || (r = {}))` so Rollup sees `r` as both
      // read and written, which prevents it from dropping the `let r;`
      // declaration during tree-shaking.
      const patched = code.replace(/\((\w+)\|\|=\{\}\)/g, '($1 || ($1 = {}))')
      if (patched !== code) {
        return { code: patched, map: null }
      }
    },
  }
}

const root = path.resolve(import.meta.dirname, '../..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root)

  const vitePort = Number(env.VITE_PORT ?? 2101)

  return {
    plugins: [
      tailwindcss(),
      tanstackRouter({}),
      react(),
      patchXtermEnumPlugin(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    envDir: root,
    server: {
      port: vitePort,
      fs: { strict: false },
      // Explicit HMR config for Electron compatibility.
      // Electron loads the Vite dev server via http://localhost, but the
      // default HMR WebSocket may try to connect via the page origin which
      // could differ (e.g., file:// or custom protocol). Force ws:// on localhost.
      hmr: {
        protocol: 'ws',
        host: 'localhost',
      },
    },
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      exclude: ['@livestore/adapter-web'],
    },
  }
})
