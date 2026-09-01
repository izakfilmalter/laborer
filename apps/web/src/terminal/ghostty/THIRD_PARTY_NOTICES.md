# Third-Party Notices — Ghostty web terminal

Everything under `apps/web/src/terminal/ghostty/` and `apps/web/src/terminal/ghostty-support/`
is vendored third-party material. Keep this notice in sync with the pin in
`native/libghostty-vt/VERSION` and with the artifacts in `vendor/`.

## Ghostty / libghostty-vt (WebAssembly artifact and C ABI headers)

- Upstream project: https://github.com/ghostty-org/ghostty
- Vendored revision: `9f62873bf195e4d8a762d768a1405a5f2f7b1697`
  (canonical pin: `native/libghostty-vt/VERSION`)
- License: MIT (`native/libghostty-vt/LICENSE`)

`vendor/ghostty-vt.wasm` is built from that revision for `wasm32-freestanding` by
`apps/web/scripts/build-libghostty-wasm.sh`, which clones the pinned commit and
builds it with Zig. The revision rides along as semver build metadata, so
`ghostty_build_info()` identifies the artifact's own provenance;
`runtimeAbi.test.ts` asserts that embedded revision against the `VERSION` file.

The C ABI headers under `native/libghostty-vt/include/ghostty/` come from the same
revision and are reference material for the binding code.

`vendor/ghostty-write-pty.wasm` is a 112-byte callback trampoline built from
`apps/web/scripts/ghostty-write-pty.zig` by the same script. It is our own source,
not Ghostty's.

## Symbols Nerd Font Mono

- File: `fonts/SymbolsNerdFontMono-Regular.woff2`
- Upstream project: https://github.com/ryanoasis/nerd-fonts
- License: MIT — Copyright (c) 2014 Ryan L McIntyre (`fonts/LICENSE`)

Symbols-only face registered lazily by `surface.ts` so prompt glyphs render
without a locally installed Nerd Font.

## t3code (binding and surface code)

The TypeScript binding, renderer, and surface code in this directory
(`runtime.ts`, `core.ts`, `renderer.ts`, `surface.ts`, `keyCodes.ts`, their tests,
and `README.md`), along with `../ghostty-support/terminal-links.ts` and the
extracts in `../ghostty-support/platform.ts` and `../ghostty-support/fonts.ts`,
are derived from t3code.

- Upstream project: https://github.com/pingdotgg/t3code
- License: MIT — Copyright (c) 2026 T3 Tools Inc.

Local changes are limited to import paths, module layout, and test-runner
imports (`vite-plus/test` → `vitest`). Terminal behavior is unmodified; keep it
that way so the tree can be re-synced against upstream.
