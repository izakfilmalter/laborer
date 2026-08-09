# Laborer — Product Requirements Document

## Problem Statement

Modern AI-assisted development often means running several coding agents across isolated workspaces, but existing tools still force developers into a single-agent view and leave worktree, terminal, port, and dev-server management to the operator.

The core pain points are:

1. **No multi-agent visibility.** Existing tools (Conductor, OpenCode Desktop, T3's tool) show one agent conversation at a time. Developers herding 4-5+ agents need to see all of them simultaneously, like a Tmux session for AI agents.

2. **Manual environment management.** Setting up isolated workspaces (worktrees, ports, dev servers, file watcher scoping) for each agent is tedious and error-prone. Tearing them down is often forgotten.

3. **Wasted local compute.** Developers with $200/month AI subscriptions get near-unlimited usage on their local machine but have no way to fully leverage their hardware for parallel agent execution.

## Solution

Laborer is a local-first, API-first application for orchestrating multiple AI coding agents in parallel. It provides:

- A **tmux-style panel system** where each pane is a live terminal (xterm.js) showing an agent's TUI, a diff viewer, or a raw shell. Panes split recursively (horizontal/vertical), resize, and persist across sessions.
- **Automated workspace isolation** via git worktrees (v1) with a pluggable provider interface for future Docker/Daytona support. Each workspace gets its own branch, port allocation, file watcher scope, and setup script execution.
- A **standalone Bun server** running Effect TS services, separate from the app. The server manages all side effects (process spawning, git operations, file system). The app can run in a browser or a Tauri desktop shell.
- **LiveStore** for reactive state sync (workspaces, terminals, sessions, layout, diffs) between server and app, with **effect-atom (`@effect-atom/atom-react`) + `@effect/rpc`** for triggering side effects via `AtomRpc` mutations.

## User Stories

1. As a developer, I want to see multiple agent sessions running simultaneously in split panes, so that I can monitor 4-5+ agents working on different tasks at the same time.
2. As a developer, I want to split and resize panes with keyboard shortcuts (tmux-style), so that I can quickly arrange my workspace without reaching for the mouse.
3. As a developer, I want each agent pane to display the agent's native TUI (via xterm.js), so that I get full fidelity of the agent's output including colors, progress indicators, and interactive elements.
4. As a developer, I want to toggle a diff viewer alongside any agent pane, so that I can see what changes the agent is making in real-time as it works.
5. As a developer, I want the diff viewer to update live as the agent modifies files, so that I can catch issues early without waiting for the agent to finish.
6. As a developer, I want to open multiple terminals per workspace (agent, type checker, test runner, raw shell), so that I can run supplementary processes alongside the coding agent.
7. As a developer, I want to also create ad-hoc workspaces for quick one-off tasks that don't warrant an issue, so that the tool doesn't force me through an issue tracker for everything.
8. As a developer, I want each workspace to have its own allocated port for its dev server, so that I can run multiple Next.js (or similar) dev servers simultaneously without port conflicts.
9. As a developer, I want the workspace setup to automatically run project-specific scripts (install deps, copy .env files, etc.), so that I don't have to manually bootstrap each worktree.
10. As a developer, I want to manage multiple projects (repos) simultaneously, so that I can work across different codebases in the same session.
11. As a developer, I want to interact with agents in human-in-the-loop mode (typing directly into the agent's terminal), so that I can guide the agent when needed.
12. As a developer, I want the entire panel layout, workspace state, and conversation history to persist when I close and reopen the app, so that I can resume exactly where I left off.
13. As a developer, I want to click a button to open a specific file from the diff viewer in Cursor/VS Code, so that I can quickly jump to code when I need to make manual edits.
14. As a developer, I want the app to work in my browser (no desktop app required), so that I can get started without installing anything beyond the server.
15. As a developer, I want an optional Tauri desktop shell, so that I get a native app experience with system tray, global shortcuts, etc.
16. As a developer, I want the server to expose an API, so that I can build custom tooling (Slack bots, CLI wrappers, CI integrations) on top of laborer.
17. As a developer, I want the file watcher load to be isolated per workspace, so that running 10 agents doesn't exhaust the OS file descriptor limit.
18. As a developer, I want workspaces to be resource-bound (no artificial limit), so that I can spin up as many as my machine can handle.
19. As a developer, I want to easily re-enter an agent session that was previously running in a workspace, so that I can resume conversation context.
20. As a developer, I want the server to run without authentication (local-only), so that there's zero friction to get started.
21. As a developer, I want the app to be keyboard-navigable with discoverable shortcuts, so that I can work efficiently without the mouse.
22. As a developer, I want to use the accept/reject UI in the diff viewer (@pierre/diffs annotations), so that I can selectively accept or reject agent changes.

## 'Polishing' Requirements

Once the core user stories are implemented, the following checks should be made:

1. **Keyboard shortcut consistency.** All panel operations (split, close, navigate, resize) should have consistent, discoverable keyboard shortcuts (managed via TanStack Hotkeys) that follow tmux conventions where applicable.
2. **Terminal rendering fidelity.** Verify that xterm.js correctly renders the TUI output of all supported agents (opencode, claude, codex) including colors, Unicode, cursor positioning, and interactive prompts.
3. **Diff viewer performance.** Ensure the live diff viewer doesn't degrade performance when the agent is making rapid changes. Debounce/throttle appropriately.
4. **Layout edge cases.** Verify panel layout persistence handles edge cases: closing the last pane in a split, deeply nested splits (5+ levels), very small pane sizes, window resizing.
5. **Workspace cleanup reliability.** Ensure workspace destruction properly cleans up all resources: kills processes, removes worktree, frees port, removes file watchers.
6. **Error handling in workspace creation.** Handle failures gracefully: worktree creation fails (dirty state), port unavailable, setup script fails, git fetch fails. Show clear error messages.
7. **Graceful server shutdown.** When the server stops, all terminals should be properly terminated, workspace state persisted, and resources freed.
8. **Loading states.** Workspace creation, agent startup, and diff computation should have appropriate loading indicators.
9. **Responsive layout.** The panel system should work well on different screen sizes, from a single 1080p monitor to a 5K display.
10. **Scroll performance.** Terminal output in xterm.js should handle large buffers (100k+ lines) without UI lag.
11. **Theme consistency.** The app chrome around terminals and diff viewers should visually integrate well. Dark mode by default. shadcn/ui theming should be consistent across all components.
12. **Status indicators.** Each workspace/terminal should have clear visual indicators of its state (running, stopped, errored, completed).
13. **Empty states.** First launch, no projects, no workspaces — all empty states should guide the user toward getting started.

## Implementation Decisions

### Architecture: Two-Process Model

Laborer runs as two processes:
- **Laborer Server**: A standalone Bun process running Effect TS v3. Manages all side effects: process spawning, PTY management, git operations, file system access, port allocation. Exposes an Effect RPC API for actions and serves as the LiveStore sync backend.
- **Laborer App** (`apps/web`): A React 19 + TypeScript frontend using Vite, TanStack Router, TanStack Form, TanStack Hotkeys, and Tailwind v4. Uses shadcn/ui (base-lyra style, backed by Base UI) for components. TanStack Form handles project and workspace configuration. TanStack Hotkeys provides declarative keyboard shortcut management for tmux-style panel operations. Includes an embedded Tauri 2 shell (`apps/web/src-tauri/`) for optional native desktop mode. Connects to the server via LiveStore for reactive state and **effect-atom (`@effect-atom/atom-react`) with `AtomRpc`** for triggering server-side actions (mutations).

The Tauri 2 desktop shell is embedded directly in `apps/web/src-tauri/`. It opens a webview to the local Vite dev server (port 3001 in dev). It adds native features (system tray, global shortcuts) but the core experience is identical in a browser. Run via `bun run desktop:dev` in the web app.

### State Management: LiveStore

All application state lives in LiveStore:
- **Projects**: id, repository path, name, and repository identity
- **Workspaces**: id, projectId, taskSource, branchName, worktreePath, port, status (creating/running/stopped/errored/destroyed), createdAt
- **Terminals**: id, workspaceId, command, status (running/stopped), PTY session reference
- **Diffs**: workspaceId, diffContent (serialized git diff output), lastUpdated
- **Panel Layout**: tree structure of splits and panes, pane-to-terminal/diff assignments

Events are committed by the client and server. The server commits durable domain changes resulting from side effects; the client stores presentation state such as panel layout.

### Action Layer: effect-atom + @effect/rpc

Server-side actions are defined as `@effect/rpc` endpoints using `Rpc.make` and `RpcGroup.make`. On the client, **`@effect-atom/atom-react`** provides the `AtomRpc` module to create a typed RPC client with built-in React integration. Actions are invoked from components as **mutations** via `AtomRpc.Tag` and `useAtomSet`. The server executes them and commits resulting state changes to LiveStore.

The RPC contract is defined in `packages/shared/src/rpc.ts` using `RpcGroup.make` and `Rpc.make` from `@effect/rpc`:

```ts
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

class LaborerRpcs extends RpcGroup.make(
  Rpc.make("workspace.create", { payload: WorkspaceCreatePayload }),
  Rpc.make("workspace.destroy", { payload: WorkspaceDestroyPayload }),
  Rpc.make("terminal.spawn", { payload: TerminalSpawnPayload, success: TerminalSpawnResult }),
  Rpc.make("terminal.write", { payload: TerminalWritePayload }),
  Rpc.make("terminal.resize", { payload: TerminalResizePayload }),
  Rpc.make("terminal.kill", { payload: TerminalKillPayload }),
  Rpc.make("terminal.remove", { payload: TerminalRemovePayload }),
  Rpc.make("terminal.restart", { payload: TerminalRestartPayload }),
  Rpc.make("diff.refresh", { payload: DiffRefreshPayload }),
  Rpc.make("editor.open", { payload: EditorOpenPayload }),
  Rpc.make("project.add", { payload: ProjectAddPayload, success: ProjectResult }),
  Rpc.make("project.remove", { payload: ProjectRemovePayload }),
  Rpc.make("health", { success: HealthResult }),
) {}
```

On the client, an `AtomRpc.Tag` wraps the RPC group and provides the WebSocket protocol layer:

```ts
import { AtomRpc } from "@effect-atom/atom-react"
import { BrowserSocket } from "@effect/platform-browser"
import { RpcClient, RpcSerialization } from "@effect/rpc"

class LaborerClient extends AtomRpc.Tag<LaborerClient>()("LaborerClient", {
  group: LaborerRpcs,
  protocol: RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
  }).pipe(
    Layer.provide(BrowserSocket.layerWebSocket("ws://localhost:3000/rpc")),
    Layer.provide(RpcSerialization.layerJson),
  ),
}) {}
```

Components invoke actions as mutations:

```tsx
const destroyWorkspace = useAtomSet(LaborerClient.mutation("workspace.destroy"))
// onClick={() => destroyWorkspace({ payload: { workspaceId } })}
```

Key RPC methods (all mutations unless noted):
- `workspace.create(projectId, branchName?)` — creates a local git worktree and runs setup
- `workspace.destroy(workspaceId)` — tears down worktree, kills processes, frees port
- `terminal.spawn(workspaceId, command?)` — creates PTY in workspace directory
- `terminal.write(terminalId, data)` — sends input to PTY
- `terminal.resize(terminalId, cols, rows)` — resizes PTY
- `terminal.kill(terminalId)` — kills terminal process
- `terminal.remove(terminalId)` — kills (if running) and removes terminal from LiveStore
- `terminal.restart(terminalId)` — kills and respawns terminal with same command, preserving terminal ID
- `diff.refresh(workspaceId)` — triggers immediate diff recalculation
- `editor.open(workspaceId, filePath?)` — opens file in Cursor/VS Code
- `project.add(repoPath)` — registers a project
- `project.remove(projectId)` — unregisters a project
- `health` — returns server status (query, not mutation)

### Modules

**1. WorkspaceProvider (Effect Service)**
An Effect service with a tag-based interface allowing multiple implementations. V1 ships with `WorktreeProvider` that wraps git worktree operations (inspired by gtr/git-worktree-runner for worktree lifecycle: creation, file copying, setup scripts, cleanup). The interface is generic enough to accommodate future `DockerProvider` and `DaytonaProvider` implementations.

Responsibilities: worktree creation/destruction, port allocation (via PortAllocator sub-service), setup script execution, file watcher scoping, branch management.

Reference: https://github.com/coderabbitai/git-worktree-runner for worktree lifecycle patterns.

**2. TerminalManager (Effect Service)**
Manages long-lived PTY instances scoped to workspaces. Agent panes, plain terminals, and dev-server terminals share this lifecycle.

Responsibilities: PTY spawning (via PTY Host child process), I/O streaming to LiveStore, terminal lifecycle (start, stop, reconnect), multiple terminals per workspace.

> **See [PRD-pty-host.md](./PRD-pty-host.md)** for the detailed design of the PTY Host process isolation architecture. Due to a Bun runtime incompatibility with `node-pty` in the HTTP server process, all PTY operations are delegated to an isolated child process via a JSON-over-stdio IPC protocol. The TerminalManager's public interface is unchanged; the PTY Host is an internal implementation detail.
>
> **See [PRD-terminal-perf.md](./PRD-terminal-perf.md)** for the terminal performance optimization design. Terminal output is moved from LiveStore to a dedicated WebSocket channel with raw text frames, 5ms data coalescing, character-count flow control (matching VS Code's model), and a 1MB ring buffer for reconnection scrollback. This eliminates base64 encoding, LiveStore overhead on the hot path, and unbounded buffering.
>
> **See [PRD-terminal-extraction.md](./PRD-terminal-extraction.md)** for the terminal service extraction design. The entire terminal subsystem (PTY Host, PtyHostClient, TerminalManager, ring buffer, WebSocket route) is extracted into a standalone `@laborer/terminal` package running as its own Bun HTTP server process. This allows terminals to survive server restarts during development. Terminal state is moved from LiveStore to in-memory (derived from PTY processes, following VS Code's architecture), with a grace period reconnection model and orphan detection.

**3. DiffService (Effect Service)**
Monitors active workspaces for file changes and produces diffs. V1 uses polling (`git diff` on an interval, likely 1-2 seconds). Future optimization: agent-event-driven (hook into agent lifecycle to trigger diff on file write events). Publishes diff data through LiveStore.

Responsibilities: diff polling, change detection, diff serialization for @pierre/diffs consumption.

**4. ProjectRegistry (Effect Service)**
Manages the repositories registered with Laborer and supplies their workspace configuration.

Responsibilities: project registration/removal, repo validation, config reading.

>
> **See [PRD-worktree-detection.md](./PRD-worktree-detection.md)** for the auto-detect worktrees design. When a project is added, Laborer detects all existing git worktrees (including the main worktree) via `git worktree list --porcelain` and creates workspace records in a "stopped" state. A filesystem watcher on `.git/worktrees/` keeps the list live — worktrees created or removed outside the app are automatically reconciled. A new `origin` column (`"laborer"` | `"external"`) on workspaces distinguishes provenance and drives origin-aware destroy behavior.
>
> **See [PRD-sidebar-workspace-ux.md](./PRD-sidebar-workspace-ux.md)** for the sidebar width, workspace card overflow, and detected worktree feature parity design. Removes the sidebar max-width cap (allowing resize up to 90%), restructures workspace cards into a two-row header layout with line-clamp text wrapping, and gives detected worktrees full feature parity (expand/collapse, terminal spawning, and all agent workflow buttons).

**5. SyncEngine (LiveStore)**
The LiveStore schema, events, materializers, and sync configuration. Defines all tables and events. Runs on both server (Node/Bun adapter) and client (browser/Tauri adapter). Handles persistence to SQLite and real-time sync between server and app.

Responsibilities: schema definition, event definitions, materializers, sync setup, persistence.

**6. ActionAPI (@effect/rpc + effect-atom)**
The `@effect/rpc` server router that exposes all side-effect operations as RPC handlers. The RPC group contract (`LaborerRpcs`) is defined in `packages/shared` using `RpcGroup.make` and `Rpc.make`. The server implements handlers that delegate to the appropriate Effect services (WorkspaceProvider, TerminalManager, DiffService, etc.) and commit resulting state to LiveStore. On the client, `AtomRpc.Tag` from `@effect-atom/atom-react` creates a typed client (`LaborerClient`) with `mutation` and `query` helpers for React components.

Responsibilities: RPC group + schema definitions (shared), server-side handler implementations, client-side `AtomRpc.Tag` setup, request validation via Effect Schema, delegation to services, error handling.

**7. PanelManager (React, App)**
Owns the tmux-style panel layout. Panes display terminals or workspace diffs, and the layout is persisted independently of terminal processes.

Responsibilities: panel splitting/resizing/closing, pane type management (terminal/diff), keyboard shortcuts (via TanStack Hotkeys), layout serialization/deserialization, xterm.js integration, @pierre/diffs integration, action invocation via AtomRpc mutations.

> **See [PRD-cmd-w-close-panel.md](./PRD-cmd-w-close-panel.md)** for the Cmd+W close panel and focused pane border design. Adds Cmd+W as a direct shortcut to close the active pane (alongside the existing Ctrl+B, X tmux-style sequence), replaces the glitched ring indicator with a solid border on the focused pane, adds focus auto-transfer to the nearest sibling on close, and shows a close-app confirmation dialog when no panes remain.

### Technology Stack

| Component | Technology | Version/Source |
|-----------|-----------|----------------|
| Runtime | Bun | Latest stable |
| Core framework | Effect TS v3 | effect |
| Reactive state | LiveStore | v0.4.0-dev.22 |
| RPC | Effect RPC + effect-atom | @effect/rpc, @effect-atom/atom-react (AtomRpc) |
| App framework | Vite + React 19 | React 19.2, Vite 6 |
| React compiler | React Compiler | Latest |
| Routing | TanStack Router | v1.141+ |
| Forms | TanStack Form | v1 |
| Keyboard shortcuts | TanStack Hotkeys | v0 (alpha) |
| Component library | shadcn/ui (base-lyra, Base UI) | v3.6+ |
| Styling | Tailwind CSS v4 | v4.0+ |
| TypeScript | tsgo (TypeScript Go) | Latest |
| Panel system | allotment | Latest |
| Terminal emulator | xterm.js | Latest |
| Diff viewer | @pierre/diffs | v1.x |
| Desktop shell | Tauri 2 | v2.4+ (embedded in apps/web) |
| Persistence | SQLite (via LiveStore) | |
| Monorepo | Turborepo + Bun workspaces | Turbo v2.8+, Bun v1.3+ |
| Linting / Formatting | Ultracite (Biome v2) | Ultracite v7.2+, Biome v2.4+ |
| Env validation | @t3-oss/env-core | v0.13+ |
| Unit / Integration testing | Vitest (via @effect/vitest) | |
| E2E testing | Playwright | Latest |

### Project Structure

```
laborer/
├── apps/
│   └── web/                 # React 19 frontend (Vite + TanStack Router)
│       ├── src/
│       │   ├── atoms/       # AtomRpc client tag (LaborerClient), action atoms
│       │   ├── components/  # shadcn/ui (base-lyra) components
│       │   │   └── ui/      # Generated shadcn/ui primitives
│       │   ├── panels/      # Panel system (allotment)
│       │   ├── panes/       # Pane types (terminal, diff)
│       │   ├── routes/      # TanStack Router file-based routes
│       │   ├── lib/         # Utilities (cn, etc.)
│       │   ├── index.css    # Tailwind v4 entry
│       │   └── main.tsx     # App entry point
│       ├── src-tauri/       # Tauri 2 desktop shell (embedded)
│       ├── components.json  # shadcn/ui config (base-lyra style)
│       ├── vite.config.ts
│       └── package.json
│
├── packages/
│   ├── config/              # Shared tsconfig base
│   │   ├── tsconfig.base.json
│   │   └── package.json
│   │
│   ├── env/                 # Environment validation (@t3-oss/env-core)
│   │   ├── src/
│   │   └── package.json
│   │
│   ├── server/              # Bun server, Effect TS services (to be created)
│   │   ├── src/
│   │   │   ├── services/
│   │   │   │   ├── WorkspaceProvider.ts
│   │   │   │   ├── TerminalManager.ts
│   │   │   │   ├── DiffService.ts
│   │   │   │   ├── PortAllocator.ts
│   │   │   │   └── ProjectRegistry.ts
│   │   │   ├── rpc/         # Effect RPC router
│   │   │   └── main.ts      # Server entry point
│   │   └── package.json
│   │
│   └── shared/              # Shared types, LiveStore schema, RPC contract (to be created)
│       ├── src/
│       │   ├── schema.ts    # LiveStore tables, events, materializers
│       │   ├── rpc.ts       # @effect/rpc group + schema definitions (RpcGroup, Rpc.make)
│       │   └── types.ts     # Shared domain types
│       └── package.json
│
├── turbo.json               # Turborepo pipeline config
├── biome.json               # Ultracite / Biome config
├── tsconfig.json            # Root tsconfig (extends packages/config)
├── e2e/                     # Playwright E2E tests
│   ├── tests/
│   └── playwright.config.ts
├── AGENTS.md                # Ultracite + Effect v3 agent rules
├── package.json             # Bun workspace root
└── bun.lock
```

### Diff Detection Strategy

V1: Poll `git diff` against each active workspace on a 1-2 second interval. `git diff` is fast on worktrees and avoids adding to the file watcher load (which is the exact problem we're trying to solve). The server runs the diff, serializes the output, and commits it to LiveStore. The UI reactively renders via @pierre/diffs.

### Workspace Port Allocation

The PortAllocator service maintains a range of available ports (e.g., 3100-3999) and assigns them to workspaces on creation. Ports are freed on workspace destruction. The allocated port is injected as an environment variable (e.g., `PORT=3142`) when running workspace setup scripts and terminals.

### Open Editor Integration

The `editor.open` RPC method executes `cursor <path>` or `code <path>` (configurable per project) to open files in the user's code editor. This is a simple shell command — no deep integration needed.

## Testing Decisions

**What makes a good test:** Tests should verify external behavior through the public interface of each module. They should not test implementation details, internal state, or private methods. Tests should be deterministic and not depend on network, timing, or OS-specific behavior (except integration tests explicitly designed for that).

**Testing frameworks:**
- **Vitest** via @effect/vitest for unit and integration tests of Effect services.
- **Playwright** for E2E tests of the full app (server + web UI). E2E tests live in `e2e/` at the repo root and test real user flows against the running app.

### Unit / Integration tests (Vitest)

**WorkspaceProvider (Integration tests)**
- Test worktree creation: verify branch created, directory exists, setup script executed.
- Test worktree destruction: verify directory removed, branch cleaned up, port freed.
- Test port allocation: verify unique ports assigned, ports recycled on destruction.
- Test concurrent workspace creation (no port collisions, no branch conflicts).
- Test failure modes: invalid repo path, dirty git state, setup script failure.

**TerminalManager (Integration tests)**
- Test PTY spawning: verify process starts, output streams correctly.
- Test terminal input: verify data reaches the process.
- Test terminal resize: verify PTY dimensions update.
- Test terminal kill: verify process terminated, resources freed.
- Test multiple terminals per workspace.

**SyncEngine (Integration tests)**
- Test event commit and materialization: commit an event, verify table state updates.
- Test reactive query: commit an event, verify subscribed query re-evaluates.
- Test persistence: commit events, restart, verify state restored.
- Test sync between server and client instances.

**ActionAPI (Integration/E2E tests)**
- Test each RPC method end-to-end: call RPC, verify side effect occurred, verify LiveStore state updated.
- Test error cases: invalid workspace ID, terminal already killed, etc.
- Test concurrent operations.

**DiffService (Integration tests)**
- Test diff detection: create a workspace, modify a file, verify diff output.
- Test diff polling: verify diffs update on interval.
- Test no-change case: verify no spurious updates when files haven't changed.

**PanelManager (Component/Integration tests)**
- Test panel splitting: split horizontal, split vertical, verify layout tree.
- Test pane assignment: assign terminal to pane, verify xterm.js renders.
- Test layout persistence: save layout, reload, verify restored.
- Test keyboard shortcuts: verify split/close/navigate actions.
- Test edge cases: close last pane, deeply nested splits, minimum pane size.

### E2E tests (Playwright)

Playwright tests run against the full stack (server + web app). They spin up the server and app, then drive a real browser. Tests live in `e2e/tests/` at the repo root.

**Core user flows to cover:**
- Add a project, create a workspace, verify it appears in the panel layout.
- Split panes, resize, close — verify layout changes persist after page reload.
- Spawn a terminal in a workspace, type a command, verify output appears in the xterm.js pane.
- Toggle the diff viewer alongside a terminal pane, verify diff content renders.
- Open multiple workspaces across multiple projects, verify all are visible and navigable.
- Keyboard shortcuts for panel operations (split, navigate, close) work correctly.
- Session persistence: create layout with workspaces and terminals, reload the page, verify everything restores.
- Empty state: first launch with no projects shows onboarding guidance.

## Out of Scope

- **Slack bot integration.** Remote task triggering via Slack is a future phase. The API-first architecture accommodates it, but v1 is local-only.
- **Docker/Daytona workspace providers.** V1 ships with git worktrees only. The `WorkspaceProvider` interface is designed for future implementations, but they are not built in v1.
- **Browser preview pane.** Embedding an iframe showing the dev server is a future enhancement. V1 focuses on terminals and diffs.
- **Authentication / multi-user.** V1 is a single-user, local-only tool with no auth.
- **Agent-specific tool protocols.** V1 treats agents as terminal processes and does not install a Laborer-owned tool server into them.
- **Mobile / tablet support.** V1 targets desktop (macOS primarily, with Linux/Windows as secondary).
- **Peer-to-peer sync.** LiveStore sync in v1 is local server-to-UI only. No multi-device or multi-user sync.

## Further Notes

### Reference Projects

- **gtr / git-worktree-runner** (https://github.com/coderabbitai/git-worktree-runner) — Reference for worktree lifecycle management patterns.
- **Effect** (https://github.com/Effect-TS/effect) — Effect TS v3, the core framework.
- **effect-atom** (https://github.com/tim-smart/effect-atom) — Reactive state management for Effect with React integration. Provides `AtomRpc` for typed RPC client mutations/queries in React components.
- **LiveStore** (https://livestore.dev) — Reactive SQLite sync engine.
- **@pierre/diffs** (https://diffs.com) — Diff rendering library.
- **allotment** (https://github.com/johnwalley/allotment) — React split pane component.
- **Better-T-Stack** (https://www.better-t-stack.dev/) — Project scaffolded from this template (TanStack Router, Tauri, Turborepo, Ultracite, Biome).
- **Ultracite** (https://www.ultracite.ai/) — Zero-config Biome preset with agent rule generation.
- **tsgo** (https://github.com/microsoft/typescript-go) — Native Go port of TypeScript for fast type checking.

### Design Philosophy

1. **Terminals are the primitive.** Agents, shells, dev servers, and supporting commands all run as terminals. The UI provides workspace and diff context around that primitive.

2. **Terminals are independent resources.** Panes may attach to long-lived terminals, but closing or replacing a pane does not terminate the process it was viewing.

3. **Local-first, API-first.** Everything runs on the developer's machine. The server is headless-capable. The API is the primary interface; the UI is a client. This enables future Slack bots, CLI wrappers, and CI integrations without architectural changes.

4. **Effect all the way down.** The server is Effect TS v3. Services are Effect services with tag-based DI. RPC is `@effect/rpc` with `effect-atom`'s `AtomRpc` on the client for typed mutations. Testing uses @effect/vitest. The shared schema uses Effect Schema (via LiveStore). This provides type safety, composability, and testability throughout.

5. **Progressive complexity.** A developer can start with one project, workspace, and terminal, then add splits, supplementary terminals, and dev servers as needed.

### Issue Tracking

Implementation issues derived from this PRD are tracked in two files:

- **[issues.md](./issues.md)** — Remaining issues (Ready / Blocked)
- **[issues-done.md](./issues-done.md)** — Completed issues (Done)
