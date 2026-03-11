import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  outDir: 'dist',
  sourcemap: true,
  clean: true,

  // Bundle workspace packages into the output so the dist/ directory is
  // self-contained (no workspace: links needed at runtime).
  noExternal: (id: string) => id.startsWith('@laborer/'),

  // Native addons and packages with WASM/binary assets must remain external
  // so they resolve from node_modules at runtime (installed by the packaging
  // step via electron-builder's dependency bundling).
  external: [
    'better-sqlite3',
    '@parcel/watcher',
    // LiveStore packages use wa-sqlite WASM and native SQLite adapters
    // that must be resolved from node_modules at runtime.
    '@livestore/adapter-node',
    '@livestore/livestore',
    '@livestore/sync-cf',
  ],
})
