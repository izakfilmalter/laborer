import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const rendererRoot = resolve('src/companion/renderer')

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve('src/companion/main.ts') } },
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve('src/companion/preload.ts'),
        output: { entryFileNames: '[name].cjs', format: 'cjs' },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    build: {
      rollupOptions: { input: resolve(rendererRoot, 'index.html') },
    },
    plugins: [
      tanstackRouter({
        generatedRouteTree: resolve(rendererRoot, 'routeTree.gen.ts'),
        routesDirectory: resolve(rendererRoot, 'routes'),
        target: 'react',
      }),
      tailwindcss(),
      react(),
    ],
    root: rendererRoot,
  },
})
