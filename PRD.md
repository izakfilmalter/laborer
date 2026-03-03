# Laborer — Product Requirements Document

## Problem Statement

Modern AI-assisted development involves running multiple coding agents simultaneously across different tasks, but the existing tooling forces developers into a single-agent-at-a-time view. Developers working with tools like rlph, OpenCode, Claude Code, and Codex find themselves manually managing terminal panes, git worktrees, port allocations, and dev server instances. The OS file watcher limit becomes a hard constraint when running 5-10 agents in parallel, each with its own dev server and file watching needs.

The core pain points are:

1. **No multi-agent visibility.** Existing tools (Conductor, OpenCode Desktop, T3's tool) show one agent conversation at a time. Developers herding 4-5+ agents need to see all of them simultaneously, like a Tmux session for AI agents.

2. **Manual environment management.** Setting up isolated workspaces (worktrees, ports, dev servers, file watcher scoping) for each agent is tedious and error-prone. Tearing them down is often forgotten.

3. **Disconnected workflows.** The pipeline from PRD writing to issue creation to implementation to review to fix is split across multiple tools (Linear, GitHub, terminal, rlph CLI). There's no unified interface.

4. **Wasted local compute.** Developers with $200/month AI subscriptions get near-unlimited usage on their local machine but have no way to fully leverage their hardware for parallel agent execution.

## Solution

Laborer is a local-first, API-first application for orchestrating multiple AI coding agents in parallel. It provides:

- A **tmux-style panel system** where each pane is a live terminal (xterm.js) showing an agent's TUI, a diff viewer, or a raw shell. Panes split recursively (horizontal/vertical), resize, and persist across sessions.
- **Automated workspace isolation** via git worktrees (v1) with a pluggable provider interface for future Docker/Daytona support. Each workspace gets its own branch, port allocation, file watcher scope, and setup script execution.
- **Task-driven lifecycle** where workspaces are created from Linear tickets or GitHub issues, and cleaned up when PRs merge or tasks close.
- A **standalone Bun server** running Effect TS services, separate from the UI. The server manages all side effects (process spawning, git operations, file system). The UI can run in a browser or a Tauri desktop shell.
- **LiveStore** for reactive state sync (workspaces, terminals, sessions, layout, diffs) between server and UI, with **Effect RPC** for triggering side effects.
- The **full rlph workflow** accessible via UI: PRD writing, issue creation, ralph loop execution, review, and fix cycles.

## User Stories

1. As a developer, I want to see multiple agent sessions running simultaneously in split panes, so that I can monitor 4-5+ agents working on different tasks at the same time.
2. As a developer, I want to split and resize panes with keyboard shortcuts (tmux-style), so that I can quickly arrange my workspace without reaching for the mouse.
3. As a developer, I want each agent pane to display the agent's native TUI (via xterm.js), so that I get full fidelity of the agent's output including colors, progress indicators, and interactive elements.
4. As a developer, I want to toggle a diff viewer alongside any agent pane, so that I can see what changes the agent is making in real-time as it works.
5. As a developer, I want the diff viewer to update live as the agent modifies files, so that I can catch issues early without waiting for the agent to finish.
6. As a developer, I want to open multiple terminals per workspace (agent, type checker, test runner, raw shell), so that I can run supplementary processes alongside the coding agent.
7. As a developer, I want workspaces to be automatically created when I pick up a task from Linear or GitHub, so that I don't have to manually set up worktrees, branches, and dev servers.
8. As a developer, I want workspaces to be automatically cleaned up when the associated PR is merged or task is closed, so that I don't accumulate stale worktrees.
9. As a developer, I want to also create ad-hoc workspaces for quick one-off tasks that don't warrant an issue, so that the tool doesn't force me through an issue tracker for everything.
10. As a developer, I want each workspace to have its own allocated port for its dev server, so that I can run multiple Next.js (or similar) dev servers simultaneously without port conflicts.
11. As a developer, I want the workspace setup to automatically run project-specific scripts (install deps, copy .env files, etc.), so that I don't have to manually bootstrap each worktree.
12. As a developer, I want to manage multiple projects (repos) simultaneously, so that I can work across different codebases in the same session.
13. As a developer, I want to start a ralph loop on a workspace via a UI button, so that I can kick off autonomous agent work without switching to a terminal.
14. As a developer, I want to write a PRD through the UI, so that I can start the full workflow (PRD -> issues -> implementation) from within laborer.
15. As a developer, I want PRD-generated issues to automatically become tasks that drive workspace creation, so that the workflow from idea to implementation is seamless.
16. As a developer, I want to interact with agents in human-in-the-loop mode (typing directly into the agent's terminal), so that I can guide the agent when needed.
17. As a developer, I want to switch between watching an autonomous ralph loop and directly interacting with an agent, so that I can intervene when the agent gets stuck.
18. As a developer, I want the entire panel layout, workspace state, and conversation history to persist when I close and reopen the app, so that I can resume exactly where I left off.
19. As a developer, I want to click a button to open a specific file from the diff viewer in Cursor/VS Code, so that I can quickly jump to code when I need to make manual edits.
20. As a developer, I want the app to work in my browser (no desktop app required), so that I can get started without installing anything beyond the server.
21. As a developer, I want an optional Tauri desktop shell, so that I get a native app experience with system tray, global shortcuts, etc.
22. As a developer, I want the server to expose an API, so that I can build custom tooling (Slack bots, CLI wrappers, CI integrations) on top of laborer.
23. As a developer, I want the file watcher load to be isolated per workspace, so that running 10 agents doesn't exhaust the OS file descriptor limit.
24. As a developer, I want to see which tasks are completed, in progress, or pending across all my active workspaces, so that I have a high-level view of what's happening.
25. As a developer, I want to trigger rlph review on a PR from the UI, so that I can review agent-produced code without leaving laborer.
26. As a developer, I want to trigger rlph fix on checked review findings from the UI, so that the review-fix cycle stays within laborer.
27. As a developer, I want workspaces to be resource-bound (no artificial limit), so that I can spin up as many as my machine can handle.
28. As a developer, I want to easily re-enter an agent session that was previously running in a workspace, so that I can resume conversation context.
29. As a developer, I want the server to run without authentication (local-only), so that there's zero friction to get started.
30. As a developer, I want the UI to be keyboard-navigable with discoverable shortcuts, so that I can work efficiently without the mouse.
31. As a developer, I want to use the accept/reject UI in the diff viewer (@pierre/diffs annotations), so that I can selectively accept or reject agent changes.

## 'Polishing' Requirements

Once the core user stories are implemented, the following checks should be made:

1. **Keyboard shortcut consistency.** All panel operations (split, close, navigate, resize) should have consistent, discoverable keyboard shortcuts that follow tmux conventions where applicable.
2. **Terminal rendering fidelity.** Verify that xterm.js correctly renders the TUI output of all supported agents (opencode, claude, codex) including colors, Unicode, cursor positioning, and interactive prompts.
3. **Diff viewer performance.** Ensure the live diff viewer doesn't degrade performance when the agent is making rapid changes. Debounce/throttle appropriately.
4. **Layout edge cases.** Verify panel layout persistence handles edge cases: closing the last pane in a split, deeply nested splits (5+ levels), very small pane sizes, window resizing.
5. **Workspace cleanup reliability.** Ensure workspace destruction properly cleans up all resources: kills processes, removes worktree, frees port, removes file watchers.
6. **Error handling in workspace creation.** Handle failures gracefully: worktree creation fails (dirty state), port unavailable, setup script fails, git fetch fails. Show clear error messages.
7. **Graceful server shutdown.** When the server stops, all terminals should be properly terminated, workspace state persisted, and resources freed.
8. **Loading states.** Workspace creation, agent startup, and diff computation should have appropriate loading indicators.
9. **Responsive layout.** The panel system should work well on different screen sizes, from a single 1080p monitor to a 5K display.
10. **Scroll performance.** Terminal output in xterm.js should handle large buffers (100k+ lines) without UI lag.
11. **Theme consistency.** The UI chrome around terminals and diff viewers should visually integrate well. Dark mode by default.
12. **Status indicators.** Each workspace/terminal should have clear visual indicators of its state (running, stopped, errored, completed).
13. **Empty states.** First launch, no projects, no workspaces — all empty states should guide the user toward getting started.

## Implementation Decisions

### Architecture: Two-Process Model

Laborer runs as two processes:
- **Laborer Server**: A standalone Bun process running Effect TS (v4, from effect-smol). Manages all side effects: process spawning, PTY management, git operations, file system access, port allocation. Exposes an Effect RPC API for actions and serves as the LiveStore sync backend.
- **Laborer UI**: A React + TypeScript frontend that runs in a browser or Tauri shell. Connects to the server via LiveStore for reactive state and Effect RPC for actions.

The Tauri desktop shell is a thin wrapper that opens a webview to the local server. It adds native features (system tray, global shortcuts) but the core experience is identical in a browser.

### State Management: LiveStore

All application state lives in LiveStore:
- **Workspaces**: id, projectId, taskSource, branchName, worktreePath, port, status (creating/running/stopped/errored/destroyed), createdAt
- **Terminals**: id, workspaceId, command, status (running/stopped), PTY session reference
- **Diffs**: workspaceId, diffContent (serialized git diff output), lastUpdated
- **Panel Layout**: tree structure of splits and panes, pane-to-terminal/diff assignments
- **Projects**: id, repoPath, name, rlphConfig
- **Tasks**: id, projectId, source (linear/github/manual/prd), externalId, title, status

Events are committed by both client and server. The server commits events for state changes resulting from side effects (workspace created, terminal output, diff updated). The client commits events for UI state (layout changes, task selection).

### Action Layer: Effect RPC

Effect RPC handles all side-effect-producing operations. The UI calls RPC methods; the server executes them and commits resulting state changes to LiveStore.

Key RPC methods:
- `workspace.create(projectId, taskConfig?)` — creates worktree, allocates port, runs setup
- `workspace.destroy(workspaceId)` — tears down worktree, kills processes, frees port
- `terminal.spawn(workspaceId, command?)` — creates PTY in workspace directory
- `terminal.write(terminalId, data)` — sends input to PTY
- `terminal.resize(terminalId, cols, rows)` — resizes PTY
- `terminal.kill(terminalId)` — kills terminal process
- `diff.refresh(workspaceId)` — triggers immediate diff recalculation
- `editor.open(workspaceId, filePath?)` — opens file in Cursor/VS Code
- `rlph.startLoop(workspaceId, options)` — convenience for spawning `rlph --once` in a terminal
- `rlph.writePRD(workspaceId, description?)` — convenience for spawning `rlph prd` in a terminal
- `rlph.review(workspaceId, prNumber)` — convenience for spawning `rlph review` in a terminal
- `rlph.fix(workspaceId, prNumber)` — convenience for spawning `rlph fix` in a terminal
- `project.add(repoPath)` — registers a project
- `project.remove(projectId)` — unregisters a project

### Modules

**1. WorkspaceProvider (Effect Service)**
An Effect service with a tag-based interface allowing multiple implementations. V1 ships with `WorktreeProvider` that wraps git worktree operations (inspired by gtr/git-worktree-runner for worktree lifecycle: creation, file copying, setup scripts, cleanup). The interface is generic enough to accommodate future `DockerProvider` and `DaytonaProvider` implementations.

Responsibilities: worktree creation/destruction, port allocation (via PortAllocator sub-service), setup script execution, file watcher scoping, branch management.

Reference: https://github.com/coderabbitai/git-worktree-runner for worktree lifecycle patterns.

**2. TerminalManager (Effect Service)**
Manages PTY instances scoped to workspaces. Spawns processes, streams I/O, handles resize, persists terminal session references for reconnection. The fundamental primitive — an "agent" is just a terminal running `opencode` or `rlph`.

Responsibilities: PTY spawning (via node-pty or Bun equivalent), I/O streaming to LiveStore, terminal lifecycle (start, stop, reconnect), multiple terminals per workspace.

**3. DiffService (Effect Service)**
Monitors active workspaces for file changes and produces diffs. V1 uses polling (`git diff` on an interval, likely 1-2 seconds). Future optimization: agent-event-driven (hook into agent lifecycle to trigger diff on file write events). Publishes diff data through LiveStore.

Responsibilities: diff polling, change detection, diff serialization for @pierre/diffs consumption.

**4. ProjectRegistry (Effect Service)**
Manages the set of projects (repos) the user is working with. Stores repo paths, validates they're git repos, reads rlph config per project. Workspaces are scoped to projects.

Responsibilities: project registration/removal, repo validation, config reading.

**5. SyncEngine (LiveStore)**
The LiveStore schema, events, materializers, and sync configuration. Defines all tables and events. Runs on both server (Node/Bun adapter) and client (browser/Tauri adapter). Handles persistence to SQLite and real-time sync between server and UI.

Responsibilities: schema definition, event definitions, materializers, sync setup, persistence.

**6. ActionAPI (Effect RPC)**
The Effect RPC router that exposes all side-effect operations. Thin layer that delegates to the appropriate Effect services (WorkspaceProvider, TerminalManager, DiffService, etc.) and commits resulting state to LiveStore.

Responsibilities: RPC method definitions, request validation, delegation to services, error handling.

**7. PanelManager (React, UI)**
The tmux-style panel system in the React frontend. Built on allotment for recursive split/resize. Each pane can display an xterm.js terminal or a @pierre/diffs diff viewer. Layout state is persisted via LiveStore.

Responsibilities: panel splitting/resizing/closing, pane type management (terminal/diff), keyboard shortcuts, layout serialization/deserialization, xterm.js integration, @pierre/diffs integration.

### Technology Stack

| Component | Technology | Version/Source |
|-----------|-----------|----------------|
| Runtime | Bun | Latest stable |
| Core framework | Effect TS v4 | effect-smol |
| Reactive state | LiveStore | v0.3+ |
| RPC | Effect RPC | From effect-smol |
| UI framework | React + TypeScript | React 19+ |
| Panel system | allotment | Latest |
| Terminal emulator | xterm.js | Latest |
| Diff viewer | @pierre/diffs | v1.x |
| Desktop shell | Tauri 2 | Optional |
| Persistence | SQLite (via LiveStore) | |
| Monorepo | Bun workspaces | |
| Testing | Vitest (via @effect/vitest) | |

### Project Structure

```
laborer/
├── packages/
│   ├── server/              # Bun server, Effect TS services
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
│   ├── ui/                  # React frontend
│   │   ├── src/
│   │   │   ├── panels/      # Panel system (allotment)
│   │   │   ├── panes/       # Pane types (terminal, diff)
│   │   │   ├── components/  # Shared UI components
│   │   │   └── main.tsx     # UI entry point
│   │   └── package.json
│   │
│   ├── shared/              # Shared types, LiveStore schema, RPC contract
│   │   ├── src/
│   │   │   ├── schema.ts    # LiveStore tables, events, materializers
│   │   │   ├── rpc.ts       # Effect RPC type definitions
│   │   │   └── types.ts     # Shared domain types
│   │   └── package.json
│   │
│   └── desktop/             # Tauri shell (optional)
│       ├── src-tauri/
│       └── package.json
│
├── package.json             # Bun workspace root
└── bun.lockb
```

### Diff Detection Strategy

V1: Poll `git diff` against each active workspace on a 1-2 second interval. `git diff` is fast on worktrees and avoids adding to the file watcher load (which is the exact problem we're trying to solve). The server runs the diff, serializes the output, and commits it to LiveStore. The UI reactively renders via @pierre/diffs.

Future optimization: If agent tooling exposes file-write events (e.g., via MCP or agent-specific hooks), use those events to trigger diff recalculation on-demand instead of polling.

### Workspace Port Allocation

The PortAllocator service maintains a range of available ports (e.g., 3100-3999) and assigns them to workspaces on creation. Ports are freed on workspace destruction. The allocated port is injected as an environment variable (e.g., `PORT=3142`) when running workspace setup scripts and terminals.

### rlph Integration

Laborer wraps rlph as a subprocess. The UI provides buttons that map to rlph commands:
- "Write PRD" → `rlph prd [description]`
- "Start Ralph Loop" → `rlph --once`
- "Review PR" → `rlph review <pr>`
- "Fix Findings" → `rlph fix <pr>`

Each of these spawns a terminal in the workspace via TerminalManager. The agent's TUI output is displayed natively in xterm.js. Task sourcing (Linear/GitHub) is handled by rlph's existing integrations.

### Open Editor Integration

The `editor.open` RPC method executes `cursor <path>` or `code <path>` (configurable per project) to open files in the user's code editor. This is a simple shell command — no deep integration needed.

## Testing Decisions

**What makes a good test:** Tests should verify external behavior through the public interface of each module. They should not test implementation details, internal state, or private methods. Tests should be deterministic and not depend on network, timing, or OS-specific behavior (except integration tests explicitly designed for that).

**Testing framework:** Vitest via @effect/vitest from effect-smol. This provides Effect-aware test utilities.

### Modules to test

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

## Out of Scope

- **Slack bot integration.** Remote task triggering via Slack is a future phase. The API-first architecture accommodates it, but v1 is local-only.
- **Docker/Daytona workspace providers.** V1 ships with git worktrees only. The `WorkspaceProvider` interface is designed for future implementations, but they are not built in v1.
- **Browser preview pane.** Embedding an iframe showing the dev server is a future enhancement. V1 focuses on terminals and diffs.
- **Authentication / multi-user.** V1 is a single-user, local-only tool with no auth.
- **Custom agent protocol.** V1 treats agents as black-box terminal processes. No custom protocol or MCP integration for agent-specific events.
- **Mobile / tablet support.** V1 targets desktop (macOS primarily, with Linux/Windows as secondary).
- **Peer-to-peer sync.** LiveStore sync in v1 is local server-to-UI only. No multi-device or multi-user sync.

## Further Notes

### Relationship to rlph

Laborer is a UI and orchestration shell for rlph, not a replacement. rlph remains a standalone CLI tool that handles the core ralph loop logic (task fetching, agent execution, review, PR submission, Linear/GitHub integration). Laborer adds: visual multi-agent management, workspace lifecycle automation, session persistence, and a panel-based UI. Over time, laborer may contribute features back to rlph or share code via a common library.

### Reference Projects

- **rlph** (https://github.com/hsubra89/rlph) — The ralph loop CLI that laborer wraps.
- **gtr / git-worktree-runner** (https://github.com/coderabbitai/git-worktree-runner) — Reference for worktree lifecycle management patterns.
- **effect-smol** (https://github.com/Effect-TS/effect-smol) — Effect TS v4, the core framework.
- **LiveStore** (https://livestore.dev) — Reactive SQLite sync engine.
- **@pierre/diffs** (https://diffs.com) — Diff rendering library.
- **allotment** (https://github.com/johnwalley/allotment) — React split pane component.

### Design Philosophy

1. **Terminals are the primitive.** Everything is a terminal. An agent is a terminal running opencode. A ralph loop is a terminal running rlph. A test runner is a terminal running vitest. The UI provides chrome around terminals (workspace context, action buttons, diff toggle), but the terminal is the fundamental unit.

2. **Local-first, API-first.** Everything runs on the developer's machine. The server is headless-capable. The API is the primary interface; the UI is a client. This enables future Slack bots, CLI wrappers, and CI integrations without architectural changes.

3. **Effect all the way down.** The server is Effect TS v4. Services are Effect services with tag-based DI. RPC is Effect RPC. Testing uses @effect/vitest. The shared schema uses Effect Schema (via LiveStore). This provides type safety, composability, and testability throughout.

4. **Progressive complexity.** A developer can start by just creating a workspace and opening a terminal. They don't need to know about ralph loops, PRDs, or Linear integration. Those features are discoverable but not required.
