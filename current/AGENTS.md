# Current: Legacy Desktop App

`current/` is the legacy Laborer desktop application: a Bun/Turborepo monorepo with React 19, Electron, Effect 3, and Effect RPC. Its service and package map is documented in `README.md`.

## Commands

Run commands from the repository root:

- Check formatting: `bun run --cwd current format`
- Fix formatting: `bun run --cwd current format:fix`
- Typecheck all workspaces: `bun run --cwd current typecheck`
- Test all workspaces: `bun run --cwd current test`
- Run the full check: `bun run --cwd current check`

`check` runs `format:fix`, so it may modify files. During development, run the narrowest relevant package test first; finish with the full check when feasible.

## Code Standards

`biome.json` and Ultracite are the formatting and linting source of truth. Let `format:fix` handle mechanical style; spend review attention on behavior, boundaries, failure modes, accessibility, and tests.

- Keep shared domain types and RPC contracts in `packages/shared` rather than duplicating boundary models.
- Model expected service failures explicitly and keep resource lifecycles scoped.
- In React, derive values during render when possible and use effects only to synchronize with external systems. Preserve semantic HTML, keyboard access, labels, and meaningful image alternatives.
- React 19 accepts `ref` as a prop; match that style instead of introducing `forwardRef`.
- Add regression coverage beside the affected package. Use `@effect/vitest` for Effect-heavy tests and existing package conventions elsewhere.

## Effect 3

Before writing Effect code:

1. Run `effect-solutions list`.
2. Read the relevant guides with `effect-solutions show <topic>...`.
3. Search `@effect` for real implementations.

This app pins Effect 3.x and matching `@effect/*` packages. Verify APIs against `current/package.json` and local usage; do not copy Effect 4-only patterns into this implementation.
