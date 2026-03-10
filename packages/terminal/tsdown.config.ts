import { defineConfig } from 'tsdown'

const shared = {
  format: 'esm' as const,
  outDir: 'dist',
  sourcemap: true,
}

export default defineConfig([
  {
    ...shared,
    entry: ['src/main.ts'],
    clean: true,

    // Bundle workspace packages into the output so the dist/ directory is
    // self-contained (no workspace: links needed at runtime).
    noExternal: (id: string) => id.startsWith('@laborer/'),

    // node-pty is a native addon that must remain external.
    external: ['node-pty'],
  },
  {
    ...shared,
    // PTY Host runs as a separate child process spawned by the terminal
    // server. It must be bundled as its own entry point.
    entry: ['src/pty-host.ts'],

    // node-pty is loaded via createRequire() at runtime — keep external.
    external: ['node-pty'],
  },
])
