import { defineConfig } from 'tsdown'

const shared = {
  format: 'cjs' as const,
  outDir: 'dist-electron',
  sourcemap: true,
  outExtensions: () => ({ js: '.cjs' }),
}

export default defineConfig([
  {
    ...shared,
    entry: ['src/main.ts'],
    clean: true,
    noExternal: (id: string) => id.startsWith('@laborer/'),
  },
  {
    ...shared,
    entry: ['src/preload.ts'],
    noExternal: (id: string) => id.startsWith('@laborer/'),
  },
  {
    // Bootstrap for utility processes — standalone entry loaded by
    // utilityProcess.fork(). Uses CJS like main/preload so it's
    // consistent, but uses dynamic import() to load ESM sidecar modules.
    ...shared,
    entry: ['src/utility-process-bootstrap.ts'],
    noExternal: (id: string) => id.startsWith('@laborer/'),
  },
])
