import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vite only understands `.wasm?init` and `.wasm?url` out of the box. The
  // vendored Ghostty ABI test imports the artifacts as `?inline` data URLs, so
  // wasm has to be a plain asset type here too.
  assetsInclude: ['**/*.wasm'],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    // The vendored Ghostty tree keeps its upstream colocated tests so it can be
    // re-synced against t3code without rewriting import paths.
    include: ['test/**/*.test.{ts,tsx}', 'src/terminal/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    maxWorkers: 3,
  },
})
