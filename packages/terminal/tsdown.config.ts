import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/utility-main.ts'],
  format: 'esm',
  outDir: 'dist',
  sourcemap: true,
  clean: true,

  // Bundle workspace packages for self-contained dist/.
  noExternal: (id: string) => id.startsWith('@laborer/'),

  // node-pty is loaded via createRequire() at runtime — keep external.
  external: ['node-pty'],
})
