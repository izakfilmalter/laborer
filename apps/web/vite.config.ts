import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

/** Regex for stripping the /terminal-rpc prefix when proxying to the terminal service. */
const TERMINAL_RPC_PREFIX = /^\/terminal-rpc/

const root = path.resolve(import.meta.dirname, '../..')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root)

  const serverPort = Number(env.VITE_SERVER_PORT ?? 2100)
  const terminalPort = Number(env.VITE_TERMINAL_PORT ?? 2102)
  const fileWatcherPort = Number(env.VITE_FILE_WATCHER_PORT ?? 2104)
  const vitePort = Number(env.VITE_PORT ?? 2101)

  return {
    plugins: [tailwindcss(), tanstackRouter({}), react()],
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
      proxy: {
        '/server-health': {
          target: `http://localhost:${serverPort}`,
          rewrite: () => '/',
        },
        '/terminal-health': {
          target: `http://localhost:${terminalPort}`,
          rewrite: () => '/',
        },
        '/file-watcher-health': {
          target: `http://localhost:${fileWatcherPort}`,
          rewrite: () => '/',
        },
        '/rpc': {
          target: `http://localhost:${serverPort}`,
          ws: true,
        },
        '/terminal-rpc': {
          target: `http://localhost:${terminalPort}`,
          rewrite: (p) => p.replace(TERMINAL_RPC_PREFIX, '/rpc'),
        },
        '/terminal': {
          target: `http://localhost:${terminalPort}`,
          ws: true,
        },
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
