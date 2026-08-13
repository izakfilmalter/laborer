# Merged-root collision inventory

Research for [#477](https://github.com/izakfilmalter/laborer/issues/477), based on the repository tree at `e63cbabc`. The inventory used both the physical directory entries (`find ... -maxdepth 1`) and tracked entries (`git ls-files`), so ignored generated/local entries are included and explicitly marked.

## Classification

- **Mechanical**: the decided root shape or ordinary relocation determines the result. Textual path edits still need validation.
- **Needs decision**: the destination, retained contract, naming, or runtime version cannot be derived safely from the decided shape.

“Delete” below means deletion as part of the already-decided hygiene/cutover, not migration to the merged tree.

## Collision and placement table

| File or directory | Current location(s) | Merged location | Class | Why / required reconciliation |
|---|---|---|---|---|
| Workspace source roots | `current/apps/`; `next/src/`, `next/tests/`, and next package-root files | `apps/web/`, `apps/desktop/`, `apps/bot/` | Mechanical | The app shape is settled. Move `current/apps/{web,desktop}` unchanged; move the complete next package under `apps/bot`, except files explicitly promoted/deleted below. |
| Shared package roots | `current/packages/{config,env,file-watcher,server,shared,task-db,terminal}/`; `next/src/task-db/` | `packages/{config,env,file-watcher,server,shared,task-db,terminal}/` | Mechanical | Package set and adoption of next's task-db implementation are settled; API reconciliation is covered by separate research. |
| `package.json` | root `package.json` (`@laborer/repository`); `current/package.json` (`laborer` workspace); `next/package.json` (`@laborer/slack-runtime`) | root `package.json`; `apps/bot/package.json` | **Needs decision** | Root must preserve root `sandcastle`, current orchestration/build/check scripts (minus settled `dev:native`), and gain a Turbo-compatible route to bot scripts. Preserve workspaces `apps/*`,`packages/*`, package manager `bun@1.3.5`, current root deps/devDeps, override `@effect/platform-node-shared=4.0.0-beta.99`, and `patchedDependencies: {}`. Preserve next dependencies/devDependencies and `trustedDependencies: ["@opencode-ai/cli"]` in `apps/bot`; Bun root resolution must be verified. Ambiguities: final root package name (`@laborer/repository` vs `laborer`), whether next remains `@laborer/slack-runtime`, and duplicate root/app `prepare`, `sandcastle`, `format`, `check`, `test`, and `typecheck` ownership. |
| Bun catalog | `current/package.json` catalog; exact Effect deps in `next/package.json` | root `package.json` `workspaces.catalog` | Mechanical | Settled lockstep catalog. Keep current catalog and add every shared `effect`/`@effect/*` dependency used by bot, pinned exactly to `4.0.0-beta.99` (`effect`, `@effect/atom-react`, `@effect/platform-node`, `@effect/platform-bun`, `@effect/sql-sqlite-bun`, `@effect/sql-sqlite-node`, `@effect/vitest`). Convert bot's direct declarations to `catalog:`. The transitive OpenCode `effect@beta.101` seen in `next/bun.lock` is not a direct catalog member and may remain unless dependency constraints permit dedupe. |
| `bun.lock` | `current/bun.lock`; `next/bun.lock` | root `bun.lock` | Mechanical | Delete both source lockfiles after generating one lock from merged manifests with Bun 1.3.5. Do not concatenate. Verify root override, bot trusted dependency, native packages (`electron`, `node-pty`, `@parcel/watcher`), and frozen install. Two Electron versions are presently intentional inputs (desktop 40.6.0, companion 43.2.0). |
| Root scripts / Turbo integration | current root scripts; next scripts `start:slack`, `dev:slack`, `start:*canary`, `companion:*`, `test`, `test:acp-compatibility`, `test:opencode-permissions`, `typecheck`, `check:secrets`, `verify:runtimes`; `current/turbo.json` | root scripts + `apps/bot/package.json` scripts + root `turbo.json` | **Needs decision** | Keep app-specific commands in bot, with paths naturally relative to `apps/bot`. Turbo currently knows only `build`, root `//#format:fix`, `typecheck`, `test`, `test:watch`, `dev`, `dev:electron`. Bot's `typecheck` deliberately runs **two** tsconfigs and its `test` excludes ACP policy/compatibility tests, so a plain Turbo task can preserve those package scripts. Decide which bot-only gates root `check` invokes (`check:secrets`, `test:acp-compatibility`, possibly `verify:runtimes`) and whether long-running `start:slack`/`dev:slack`/`companion:dev` receive Turbo tasks or remain filtered/direct scripts. Do not accidentally run ACP compatibility in the generic `test` task. |
| `turbo.json` | `current/turbo.json` | root `turbo.json` | Mechanical, after above decision | Promote current config. Existing task definitions can run bot's `build` (`companion:build` naming may need an alias), `typecheck`, and `test`; add only tasks chosen above. Update outputs to include bot `out/**` if bot build is mapped to `build`. |
| `biome.json` | `current/biome.json`; `next/biome.json` | root `biome.json` | Mechanical | Settled: current wins (Ultracite core+react, single quotes, `asNeeded`). Union bot exclusions into `files.includes`, notably `!**/.laborer-runtime` and `!**/out`; retain current exclusions for dist, dist-electron, routeTree, release, etc. Remove obsolete `!bts.jsonc` and possibly `!**/release` after hygiene only if no generated release output needs exclusion. Reformat bot separately as decided. |
| TypeScript root/base configs | `current/tsconfig.json`; `current/packages/config/tsconfig.base.json`; `next/tsconfig.json`; `next/tsconfig.companion.json` | root `tsconfig.json`; `packages/config/tsconfig.base.json`; `apps/bot/tsconfig.json`; `apps/bot/tsconfig.companion.json` | Mechanical | Promote current root config unchanged in role. Settled shared base remains in config package; bot extends it while retaining its stricter/runtime overrides. Keep companion config beside bot config; preserve bot script's two `tsc` invocations. Relative `./tsconfig.json` remains valid after moving both together. |
| `vitest.config.ts` | `next/vitest.config.ts` | `apps/bot/vitest.config.ts` | Mechanical | Package-local test config, no root collision. |
| `electron.vite.config.ts` | `next/electron.vite.config.ts` | `apps/bot/electron.vite.config.ts` | Mechanical | Companion-local build config and bot tsconfig include; keep package-local. |
| Node runtime declaration | `next/.node-version` = `24.11.1`; `next/package.json` engines Node `24.11.1`; desktop dependency Electron `40.6.0`; bot companion Electron `43.2.0` | likely root `.node-version`; bot `engines`; two app-local Electron dependencies | **Needs decision** | Decide whether Node 24.11.1 governs the whole repo (promote `.node-version`) or only bot (keep `apps/bot/.node-version`, which many version managers will not discover from root). Also decide whether exact engine belongs only on bot or root. Do **not** unify Electron versions mechanically: desktop runtime is 40.6.0 while bot companion is 43.2.0, and Electron embeds its own Node runtime; test both independently. |
| `.gitignore` | root `.gitignore`; nested tool ignores `.opencode/.gitignore`, `.sandcastle/.gitignore` | root `.gitignore` plus nested tool ignores | Mechanical | Root file already covers dependencies, build outputs (`release`, `out`), env files while allowing `.env.example`, `.laborer-runtime/`, Turbo, IDE/local data, and `.reference/`; it already applies to flattened paths. Preserve nested tool-specific ignores. “Union” requires no missing current/next root ignore because neither has one. Remove the generic `release` rule only if the hygiene decision means release output should no longer be ignored; otherwise it still protects generated desktop artifacts. |
| Environment files | committed `next/.env.example`; ignored `current/.env.local` with Daytona variables; ignored `next/.env.local` with Slack variables | `apps/bot/.env.example`; local env placement TBD; delete `current/.env.local` | **Needs decision** | Deleting the committed/current Daytona secret file is settled. The example is bot-specific and moves mechanically. Decide the merged local-env contract: current package scripts resolve `../../.env.local` to root after flattening, while bot scripts currently read package-local `.env.local`; choose root `.env.local`, `apps/bot/.env.local`, or documented split, and update scripts/setup copying accordingly. Never copy secret values into tracked files. |
| `laborer.json` | root superset; `next/laborer.json` subset | root `laborer.json` only | Mechanical | Root already contains next's application block. Delete next copy. Change `devServer.startCommand` from `bun run --cwd current dev` to the chosen root command (likely `bun run dev`) and `setupScripts` from `sh ./current/scripts/worktree-setup.sh --no-ports` to `sh ./scripts/worktree-setup.sh --no-ports`. Preserve `agent` and `worktreeDir`. Validate bot root resolution: production uses `LABORER_ROOT ?? process.cwd()`, while canary `live.ts` derives two levels from source; after moving under `apps/bot`, that derivation lands at `apps/bot`, not repo root, so its intended config root needs explicit verification outside this mechanical JSON edit. |
| `.laborer-runtime/` | ignored root `.laborer-runtime/`; ignored `next/.laborer-runtime/` | no retained directory; root ignore remains | Mechanical | Both are obsolete pre-Chat state, not source. Delete, do not merge/archive. `deleteRetiredSlackRuntimeState(projectRoot)` resolves `<projectRoot>/.laborer-runtime` and recursively deletes it at daemon startup; current state now lives under XDG state. Ensure startup receives repo root if the root copy must be cleaned; bot-directory startup would only clean `apps/bot/.laborer-runtime`. |
| `scripts/` | `current/scripts/` (8 files) | root `scripts/` | Mechanical | Promote all scripts because root package commands and desktop packaging use them. Most TS imports use `../apps`, `../packages`, and `../package.json`; these become correct at root without edits. Internal packaging paths (`apps/*`, `packages/*`, `scripts/smoke-test...`) also remain correct. |
| `scripts/worktree-setup.sh` path assumptions | `current/scripts/worktree-setup.sh` | `scripts/worktree-setup.sh` | Mechanical | Set `APP_DIR="$WORKTREE_ROOT"`; write `.worktree-index` and merged env in the chosen root/env location; change slug call from `$ROOT_WORKTREE_PATH/current/scripts/...` to `$ROOT_WORKTREE_PATH/scripts/...`; run `bun install --cwd "$WORKTREE_ROOT"`; update printed `cd current &&` instruction. The script's `.reference` copy remains root-correct. |
| `.gtr-setup.sh` | root `.gtr-setup.sh` | root `.gtr-setup.sh` | Mechanical | Update generated Biome extend from `../<repo>/current/biome.json` to `../<repo>/biome.json`; env-copy include from `current/.env.local` to the decided env location; post-create hook from `current/scripts/...` to `scripts/...`; update comments. |
| Other hardcoded `current/`/`next/` paths | root docs/agent instructions; `next/src/acp-compatibility/runtime-matrix.ts`; workflows | corresponding merged paths | Mechanical | Rewrite live references. In particular the ACP failure text currently says update `next/docs/acp-runtime-matrix.md`; it becomes `apps/bot/docs/acp-runtime-matrix.md`. CI files are deleted rather than rewritten. README/AGENTS references are handled below. |
| `AGENTS.md` layering | root, `current/AGENTS.md`, `next/AGENTS.md` | root `AGENTS.md`; `apps/desktop/AGENTS.md` and/or app/package-local guidance; `apps/bot/AGENTS.md` | **Needs decision** | Nearest-file semantics change when current's one workspace-wide file loses its `current/` boundary: placing it only under `apps/desktop` would stop governing `apps/web` and `packages/*`; placing it at root would incorrectly govern bot. Decide where to duplicate/split shared legacy standards (likely scoped files under legacy apps/packages) and rewrite commands. Bot guidance moves mechanically to `apps/bot/AGENTS.md`. Root guidance must stop describing `current/` and `next/` roots and describe app/package boundaries. No `current/docs/AGENTS.md` or `next/docs/AGENTS.md` exists despite the prompt's initial shorthand. |
| `docs/` | root `docs/`; `current/docs/`; `next/docs/` | root `docs/` plus app-local docs, exact legacy placement TBD; bot docs likely `apps/bot/docs/` | **Needs decision** | Root docs contain cross-product ADRs, agent conventions, specs, and research and should stay. Bot docs are operationally tied to bot and their existing source references assume that package, favoring app-local placement. Current docs are a large historical planning corpus with colliding generic names (`PRD.md`, `issues.md`, `progress.txt`) and cannot be dumped into root. Decide `apps/{desktop|web}/docs`, a namespaced `docs/legacy/`, or archival deletion policy; preserve nearest-AGENTS behavior deliberately. |
| README files | root, `current/README.md`, `next/README.md` | root `README.md`; app README(s), likely `apps/desktop/README.md` and `apps/bot/README.md` | **Needs decision** | Rewrite root from “two independent roots” to monorepo commands/layout. Bot README moves and its `next/`/`--cwd next` references change. Current README describes both desktop and web/backend, so putting it under desktop is plausible but not mechanically dictated; choose one app-local or namespaced home. |
| Slack app manifest | `next/slack-app-manifest.yaml` | likely `apps/bot/slack-app-manifest.yaml` | **Needs decision** | It is app-specific, but external Slack CLI/operator commands may assume a repository-root manifest. Confirm invocation/discovery before choosing app-local versus root. |
| `.dockerignore` | `next/.dockerignore` | likely `apps/bot/.dockerignore`, or root if Docker build context becomes root | **Needs decision** | Placement depends on Docker build context, which the repository does not declare here. Do not move blindly. |
| `.github/` | root `.github/workflows/{current-ci.yml,release.yml}` | delete workflows (possibly leave empty/remove `.github`) | Mechanical | CI removal is settled. Both workflows hardcode `current` working directories/paths and are intentionally not repaired in this effort. |
| Root tooling/config dirs | root `opencode.json`, `.opencode/`, `.sandcastle/`, `.claude/`, `.codex/`, `.cursor/`, `.reference/` | unchanged at root | Mechanical | Repository-level agent/tool configuration. Preserve nested ignores and root references. `.reference/` is ignored local material, not committed source. `.opencode/` and `.sandcastle/` contain both tracked config/code and ignored generated dependencies/logs; move neither generated contents nor their roots. |
| `.vscode/` | `current/.vscode/settings.json` (tracked) | root `.vscode/settings.json` | **Needs decision** | Flattening makes it repository-wide. Inspect whether its settings are appropriate for bot before promotion; otherwise split via workspace files or app scoping. Root `.gitignore` explicitly allows standard tracked `.vscode` files. |
| `.DS_Store` | ignored root, current, and generated release copies | delete | Mechanical | OS artifacts, covered by root ignore. |
| `.turbo/` | ignored root and current copies | delete caches; regenerate root cache | Mechanical | No source; root ignore already covers every `.turbo`. |
| `node_modules/` | ignored `current/node_modules`, `next/node_modules` (and tool-local copies) | root install output | Mechanical | Delete old installs and run one root `bun install`; never move modules. |
| `release/` | ignored `current/release/` binaries/metadata | delete | Mechanical | Settled hygiene. It is currently untracked/ignored in this checkout despite issue wording “committed”; delete generated artifacts either way. Packaging may later recreate root `release/` because scripts' `REPO_ROOT` changes. |
| `out/` | ignored `next/out/` (`main.js`, preload) | delete generated copy; future bot output location must match config | Mechanical | Build artifact, not source. Rebuild after move. If electron-vite continues package-local, output becomes `apps/bot/out`; include it in root Biome ignores and Turbo outputs if cached. |
| `bts.jsonc` | `current/bts.jsonc` | delete | Mechanical | Settled stale Better-T-Stack artifact. Remove obsolete Biome exclusion. |
| Loose planning files | `current/PRD-file-watcher-extraction.md`, `current/issues-done.md`, `current/issues-pty-host.md` | delete | Mechanical | Settled hygiene retirement. Other planning material under `current/docs/` requires the docs decision above. |
| `CONTEXT.md` | root | root | Mechanical | Canonical domain context remains repository-wide. Update only stale layout terminology during implementation. |
| Root meta artifacts | root `.git/`, `.gitignore`, `.gtr-setup.sh`, `AGENTS.md`, `CONTEXT.md`, `README.md`, `laborer.json`, `opencode.json`, `package.json` | root | Mechanical except rows above | `.git/` is worktree metadata and is never moved. All editable collisions are broken out above. |

## Exhaustive physical top-level inventory

These lists record **every directory entry observed**, including ignored local/build artifacts, and map each to a row above.

### Repository root

| Entry | Disposition |
|---|---|
| `.git/` | Retain repository metadata. |
| `.github/` | Delete workflows (settled). |
| `.gitignore` | Retain/union mechanically. |
| `.gtr-setup.sh` | Retain; update flattened paths. |
| `.laborer-runtime/` | Delete retired ignored state. |
| `.opencode/`, `.sandcastle/` | Retain root tooling; discard only ignored generated contents as normal. |
| `.reference/` | Retain ignored root reference convention. |
| `.claude/`, `.codex/`, `.cursor/` | Retain repository tooling. |
| `.turbo/`, `.DS_Store` | Delete ignored local artifacts. |
| `AGENTS.md`, `CONTEXT.md`, `README.md` | Retain/rewrite as described. |
| `docs/` | Retain canonical root docs. |
| `laborer.json`, `opencode.json`, `package.json` | Retain/merge as described. |
| `current/`, `next/` | Remove after all listed contents are moved/deleted. |

### `current/`

| Entry | Disposition |
|---|---|
| `.DS_Store`, `.turbo/`, `node_modules/` | Delete local/generated artifacts. |
| `.env.local` | Delete Daytona file; settle replacement env contract. |
| `.vscode/` | Needs decision before root promotion. |
| `AGENTS.md`, `README.md`, `docs/` | Needs layering/placement decisions. |
| `PRD-file-watcher-extraction.md`, `issues-done.md`, `issues-pty-host.md` | Delete (settled hygiene). |
| `apps/`, `packages/` | Promote to root peers (with separately settled task-db adoption). |
| `biome.json`, `bun.lock`, `package.json`, `tsconfig.json`, `turbo.json` | Promote/merge into root roles. |
| `bts.jsonc`, `release/` | Delete. |
| `scripts/` | Promote to root and update setup paths. |

### `next/`

| Entry | Disposition |
|---|---|
| `.dockerignore` | Needs Docker-context decision. |
| `.env.example` | Move to bot; local `.env.local` remains ignored and needs env-contract decision. |
| `.laborer-runtime/` | Delete retired ignored state. |
| `.node-version` | Needs repository-vs-app runtime decision. |
| `AGENTS.md`, `README.md`, `docs/` | Move to bot/rewrite, subject to docs layering. |
| `biome.json`, `bun.lock` | Delete after root merge/regeneration. |
| `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.companion.json`, `vitest.config.ts` | Move to bot package root. |
| `laborer.json` | Absorb into root then delete duplicate. |
| `package.json` | Move to bot and reconcile shared catalog/root orchestration. |
| `slack-app-manifest.yaml` | Needs operator/discovery placement decision. |
| `src/`, `tests/` | Move to bot, except settled extraction/adoption of task-db code. |
| `node_modules/`, `out/` | Delete generated artifacts; regenerate from root install/build. |

## Script and task hazards to put directly in the merge spec

1. **Worktree scripts are not a pure directory move.** `worktree-setup.sh` hardcodes `APP_DIR=$WORKTREE_ROOT/current`, a root-worktree slug path under `current/scripts`, `.env.local` under the app dir, `bun install --cwd current`, and a `cd current` instruction. `.gtr-setup.sh` independently hardcodes current's Biome file, env copy path, and setup-hook path.
2. **Desktop build scripts mostly become correct by promotion.** `build-desktop-artifact.ts` and `cleanup-livestore-files.ts` import `../apps`, `../packages`, and `../package.json`; after `scripts/` reaches root those resolve to the intended merged tree. Release helper scripts assume their process root owns `apps/*` and likewise fit root execution. Preserve the packaging script's relative `scripts/smoke-test-packaged-mcp.mjs` references.
3. **Bot checks are not equivalent to current Turbo checks.** Bot `typecheck` covers normal and companion tsconfigs. Generic bot `test` intentionally excludes both OpenCode permission-policy and ACP compatibility tests; `test:acp-compatibility` runs them serially. `check:secrets` and `verify:runtimes` are separate. The merged root check contract must name which are required rather than silently treating `turbo test` as full coverage.
4. **Long-running tasks need explicit semantics.** Current Turbo marks `dev` and `dev:electron` persistent; bot adds `dev:slack` and `companion:dev`, while `start:slack` is an operator command. If added to Turbo, mark development daemons persistent/cache false; production start commands should generally remain direct filtered scripts.
5. **Runtime roots can shift with cwd/source relocation.** Bot production defaults `LABORER_ROOT` to `process.cwd()`, while the ACP canary derives a root from `import.meta.url`. The flatten must test that both read root `laborer.json` and clean the intended retired root state.

## Decisions still required

1. Root package name and bot package rename (if any).
2. Exact root command/check API and which bot-only security/compatibility/runtime gates it includes.
3. Whether Node 24.11.1 is repo-wide; keep Electron 40 and 43 independent unless a separate compatibility effort proves unification.
4. Root versus bot-local env files and corresponding `with-env`, Node `--env-file`, gtr copy, and worktree setup behavior.
5. AGENTS/README/docs scoping for legacy workspace-wide guidance and historical current docs.
6. Slack manifest and Docker ignore placement based on actual operator/build context.
7. Whether current `.vscode/settings.json` is safe as repository-wide configuration.

Everything else in the three physical root inventories has a mechanical destination or an already-decided deletion.
