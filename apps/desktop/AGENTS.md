# Current: Legacy Desktop App

`apps/desktop/` is the legacy Laborer desktop application: a Bun/Turborepo monorepo with React 19, Electron, Effect 4, and integrated Effect RPC. Its service and package map is documented in `README.md`.

## Commands

Run commands from the repository root:

- Check formatting: `bun run format`
- Fix formatting: `bun run format:fix`
- Typecheck all workspaces: `bun run typecheck`
- Test all workspaces: `bun run test`
- Run the full check: `bun run check`

`check` runs `format:fix`, so it may modify files. During development, run the narrowest relevant package test first; finish with the full check when feasible.

## Code Standards

`biome.json` and Ultracite are the formatting and linting source of truth. Let `format:fix` handle mechanical style; spend review attention on behavior, boundaries, failure modes, accessibility, and tests.

- Keep shared domain types and RPC contracts in `packages/shared` rather than duplicating boundary models.
- Model expected service failures explicitly and keep resource lifecycles scoped.
- In React, derive values during render when possible and use effects only to synchronize with external systems. Preserve semantic HTML, keyboard access, labels, and meaningful image alternatives.
- React 19 accepts `ref` as a prop; match that style instead of introducing `forwardRef`.
- Add regression coverage beside the affected package. Use `@effect/vitest` for Effect-heavy tests and existing package conventions elsewhere.

## Effect 4

`apps/desktop/` and `apps/bot/` pin their shared Effect 4 beta packages in lockstep. `package.json` is authoritative for the packages used by this implementation; compare shared package versions with `apps/bot/package.json` and do not bump them independently.

Before writing or reviewing Effect code:

1. Run `effect-solutions list`.
2. Read the relevant guides with `effect-solutions show <topic>...`.
3. Verify examples against `package.json`, installed types, and existing `apps/desktop/` and `apps/bot/` usage; the guides may lag beta API changes.
4. Search `@effect` for implementations and tests, then reconcile them with the installed version rather than guessing an API.

Where Effect 4 requires a new shape, follow `apps/bot/` conventions: narrow named `Context.Service` contracts, explicit `Layer` composition, scoped acquisition and finalization, `Schema` codecs at untrusted or persisted boundaries, `Schema.TaggedError` classes for expected failures, injected and redacted config, and `@effect/vitest` Effect tests. Use only established `effect/unstable/*` imports. Otherwise preserve the existing shape rather than modernizing unrelated code.
