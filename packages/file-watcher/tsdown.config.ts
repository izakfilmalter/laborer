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

  // @parcel/watcher is a native addon that must remain external.
  external: ['@parcel/watcher'],
})
