import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/utility-main.ts', 'src/main.ts'],
  format: 'esm',
  outDir: 'dist',
  sourcemap: true,
  clean: true,

  // @laborer/task-db reads its SQL migrations at runtime via
  // `new URL('./migrations/*.sql', import.meta.url)`. Once task-db is
  // bundled into dist/ (see noExternal below), that URL resolves relative
  // to the bundle, so the .sql files must be copied next to it. Without
  // this, the packaged server sidecar crashes at import time with ENOENT
  // and the desktop app gets ERR_CONNECTION_REFUSED on port 3773.
  copy: [
    {
      from: '../task-db/src/migrations',
      to: 'dist',
    },
  ],

  // Bundle workspace packages into the output so the dist/ directory is
  // self-contained (no workspace: links needed at runtime).
  noExternal: (id: string) => id.startsWith('@laborer/'),

  // Native addons and packages with WASM/binary assets must remain external
  // so they resolve from node_modules at runtime (installed by the packaging
  // step via electron-builder's dependency bundling).
  external: [
    // sql.js loads WASM assets at runtime and must be resolved from
    // node_modules (not bundled inline).
    'sql.js',
    // LiveStore packages use wa-sqlite WASM and native SQLite adapters
    // that must be resolved from node_modules at runtime.
    '@livestore/adapter-node',
    '@livestore/livestore',
    '@livestore/sync-cf',
  ],
})
