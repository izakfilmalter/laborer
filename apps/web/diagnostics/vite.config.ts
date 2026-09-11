import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  assetsInclude: ['**/*.wasm'],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '../src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.DIAGNOSTIC_PORT ?? 4179),
    strictPort: true,
  },
})
