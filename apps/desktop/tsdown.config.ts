import { defineConfig } from 'tsdown'

const shared = {
  format: 'cjs' as const,
  outDir: 'dist-electron',
  sourcemap: true,
  outExtensions: () => ({ js: '.js' }),
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
])
