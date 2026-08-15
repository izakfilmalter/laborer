import { defineConfig } from 'tsdown'

const shared = {
  format: 'esm',
  outDir: 'dist',
  sourcemap: true,

  // @laborer/task-db reads its SQL migrations at runtime via
  // `new URL('./migrations/*.sql', import.meta.url)`. Once task-db is
  // bundled into dist/ (see noExternal below), that URL resolves relative
  // to the bundle, so the .sql files must be copied next to it. Without
  // this, the packaged server sidecar crashes at import time with ENOENT
  // and the desktop app backend fails during startup.
  copy: [
    {
      from: '../task-db/src/migrations',
      to: 'dist',
    },
  ],

  // Bundle workspace packages into the output so the dist/ directory is
  // self-contained (no workspace: links needed at runtime).
} as const

export default defineConfig([
  {
    ...shared,
    // The dev runner seeds dist before launching Node's watcher. Preserve that
    // complete entry while the first watch build replaces its chunks, or Node
    // can observe a transient missing entry and stay dead until another save.
    clean: process.env.LABORER_DEV_WATCH !== '1',
    entry: ['src/daemon-main.ts'],
    noExternal: (id: string) => id.startsWith('@laborer/'),
    inlineOnly: false,
    // Native addons are loaded from the installed package at runtime.
    external: ['@parcel/watcher', 'node-pty'],
  },
  {
    ...shared,
    clean: false,
    entry: ['src/task-mcp-runtime.ts'],
    // The runtime is self-contained rather than relying on the app's asar or
    // node_modules. It remains separate from the tiny guarded launcher so an
    // old Node never resolves node:sqlite.
    noExternal: [/.*/],
    inlineOnly: false,
    outputOptions: { codeSplitting: false },
  },
  {
    ...shared,
    clean: false,
    entry: ['src/task-mcp-main.ts'],
    noExternal: (id: string) => id.startsWith('@laborer/'),
  },
])
