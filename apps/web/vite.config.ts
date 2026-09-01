import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

const root = path.resolve(import.meta.dirname, '../..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, '')

  const vitePort = Number(env.VITE_PORT ?? 2101)
  const daemonPort = Number(env.LABORER_DAEMON_PORT ?? 2100)
  const daemonOrigin = `http://127.0.0.1:${String(daemonPort)}`

  return {
    // Vite only understands `.wasm?init` and `.wasm?url` out of the box. The
    // vendored Ghostty runtime imports its artifacts as `?url` and
    // `?url&no-inline`, so wasm has to be a plain asset type.
    assetsInclude: ['**/*.wasm'],
    plugins: [tailwindcss(), tanstackRouter({}), react()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    envDir: root,
    server: {
      port: vitePort,
      strictPort: true,
      fs: { strict: false },
      proxy: {
        '/api': { target: daemonOrigin },
        '/health': { target: daemonOrigin },
        '/ws': { target: daemonOrigin, ws: true },
      },
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
  }
})
