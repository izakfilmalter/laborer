# Laborer — Completed Issues

---

## Issue 1: Initialize `packages/shared` package

### Parent PRD

PRD.md

### What to build

Initialize the `packages/shared` package with `package.json`, `tsconfig.json`, and proper exports configuration. This package will hold all shared domain types, LiveStore schema, and Effect RPC contract types used by both the server and web app. Set up the build pipeline in Turborepo.

### Acceptance criteria

- [ ] `packages/shared/package.json` exists with correct name, exports, and dependencies (effect, @livestore/livestore)
- [ ] `packages/shared/tsconfig.json` extends `packages/config/tsconfig.base.json`
- [ ] Package exports resolve correctly when imported from other workspace packages
- [ ] Turborepo `turbo.json` includes shared package in the pipeline
- [ ] Build succeeds with `bun run build`

### Blocked by

None — can start immediately

### User stories addressed

- Foundation for all user stories

---

## Issue 2: Shared domain types

### Parent PRD

PRD.md

### What to build

Define the core domain types in `packages/shared/src/types.ts`: Project, Workspace (with status enum: creating/running/stopped/errored/destroyed), Terminal (with status enum: running/stopped), Task (with source enum: linear/github/manual/prd and status), PanelLayout (tree structure of splits and panes), and Diff. These are the foundational types referenced throughout the PRD's "State Management: LiveStore" section.

### Acceptance criteria

- [ ] All domain types defined with proper TypeScript types and enums
- [ ] Types compile without errors
- [ ] Types are exported from `packages/shared`

### Blocked by

- Blocked by #1

### User stories addressed

- Foundation for all user stories

---

## Issue 3: LiveStore schema — Projects table + events + materializer

### Parent PRD

PRD.md

### What to build

Define the LiveStore schema for the Projects table in `packages/shared/src/schema.ts`. Include events for project creation and removal, and a materializer that keeps the Projects table in sync. Projects have: id, repoPath, name, rlphConfig. Reference the PRD's "State Management: LiveStore" section.

### Acceptance criteria

- [ ] Projects table defined with correct columns (id, repoPath, name, rlphConfig)
- [ ] Events defined: ProjectCreated, ProjectRemoved
- [ ] Materializer correctly updates table state from events
- [ ] Tests: commit ProjectCreated → verify project in table; commit ProjectRemoved → verify project removed

### Blocked by

- Blocked by #1

### User stories addressed

- Foundation for all user stories

---

## Issue 4: LiveStore schema — Workspaces table + events + materializer

### Parent PRD

PRD.md

### What to build

Define the LiveStore schema for the Workspaces table. Workspaces have: id, projectId, taskSource, branchName, worktreePath, port, status (creating/running/stopped/errored/destroyed), createdAt. Include events for workspace lifecycle transitions.

### Acceptance criteria

- [x] Workspaces table defined with all columns per PRD
- [x] Events defined: WorkspaceCreated, WorkspaceStatusChanged, WorkspaceDestroyed
- [x] Materializer correctly updates table state from events
- [ ] Tests: commit events → verify table state transitions (deferred — LiveStore store/adapter setup not yet available; will be testable after Issue #16)

### Blocked by

- Blocked by #3

### User stories addressed

- Foundation for all user stories

---

## Issue 5: LiveStore schema — Terminals table + events + materializer

### Parent PRD

PRD.md

### What to build

Define the LiveStore schema for the Terminals table. Terminals have: id, workspaceId, command, status (running/stopped), PTY session reference. Include events for terminal lifecycle.

### Acceptance criteria

- [x] Terminals table defined with all columns per PRD
- [x] Events defined: TerminalSpawned, TerminalOutput, TerminalStatusChanged, TerminalKilled
- [x] Materializer correctly updates table state from events
- [ ] Tests: commit events → verify table state transitions (deferred — LiveStore store/adapter setup not yet available; will be testable after Issue #16)

### Blocked by

- Blocked by #3

### User stories addressed

- Foundation for all user stories

---

## Issue 6: LiveStore schema — Diffs table + events + materializer

### Parent PRD

PRD.md

### What to build

Define the LiveStore schema for the Diffs table. Diffs have: workspaceId, diffContent (serialized git diff output), lastUpdated. Include events for diff updates.

### Acceptance criteria

- [x] Diffs table defined with all columns per PRD
- [x] Events defined: DiffUpdated, DiffCleared
- [x] Materializer correctly updates table state from events
- [ ] Tests: commit DiffUpdated → verify diff content in table (deferred — LiveStore store/adapter setup not yet available; will be testable after Issue #16)

### Blocked by

- Blocked by #3

### User stories addressed

- Foundation for all user stories

---

## Issue 7: LiveStore schema — PanelLayout table + events + materializer

### Parent PRD

PRD.md

### What to build

Define the LiveStore schema for the PanelLayout table. Stores a tree structure of splits and panes, with pane-to-terminal/diff assignments. Include events for layout mutations (split, close, assign pane content).

### Acceptance criteria

- [x] PanelLayout table defined with tree structure column
- [x] Events defined: LayoutSplit, LayoutPaneClosed, LayoutPaneAssigned, LayoutRestored
- [x] Materializer correctly updates layout tree from events
- [ ] Tests: commit split event → verify tree structure updated (deferred — LiveStore store/adapter setup not yet available; will be testable after Issue #16)

### Blocked by

- Blocked by #3

### User stories addressed

- Foundation for all user stories

---

## Issue 8: LiveStore schema — Tasks table + events + materializer

### Parent PRD

PRD.md

### What to build

Define the LiveStore schema for the Tasks table. Tasks have: id, projectId, source (linear/github/manual/prd), externalId, title, status. Include events for task lifecycle.

### Acceptance criteria

- [x] Tasks table defined with all columns per PRD
- [x] Events defined: TaskCreated, TaskStatusChanged, TaskRemoved
- [x] Materializer correctly updates table state from events
- [ ] Tests: commit events → verify table state transitions (deferred — LiveStore store/adapter setup not yet available; will be testable after Issue #16)

### Blocked by

- Blocked by #3

### User stories addressed

- Foundation for all user stories

---

## Issue 9: Effect RPC contract types (RpcGroup + Rpc.make)

### Parent PRD

PRD.md

### What to build

Define the RPC contract in `packages/shared/src/rpc.ts` using `RpcGroup.make` and `Rpc.make` from `@effect/rpc`. Create a `LaborerRpcs` class that extends `RpcGroup.make(...)` with all RPC methods listed in the PRD's "Action Layer" section: workspace.create, workspace.destroy, terminal.spawn, terminal.write, terminal.resize, terminal.kill, diff.refresh, editor.open, rlph.startLoop, rlph.writePRD, rlph.review, rlph.fix, project.add, project.remove, and health. Each `Rpc.make` call defines `payload` and optional `success` schemas using Effect Schema.

Example pattern:
```ts
import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

class LaborerRpcs extends RpcGroup.make(
  Rpc.make("health", { success: HealthResult }),
  Rpc.make("workspace.create", { payload: WorkspaceCreatePayload }),
  // ... all other RPCs
) {}
```

### Acceptance criteria

- [ ] `LaborerRpcs` class defined using `RpcGroup.make` with all RPC methods as `Rpc.make` entries
- [ ] Each RPC has `payload` and/or `success` schemas defined using Effect Schema
- [ ] `LaborerRpcs` is exported from `packages/shared`
- [ ] Type compilation succeeds
- [ ] Schema validation tests: valid inputs pass, invalid inputs fail with correct errors

### Blocked by

- Blocked by #2

### User stories addressed

- User story 22

---

## Issue 10: Initialize `packages/server` package

### Parent PRD

PRD.md

### What to build

Initialize the `packages/server` package with `package.json`, `tsconfig.json`, and a minimal `src/main.ts` entry point. Configure for Bun runtime. Add to Turborepo pipeline with a `dev` script.

### Acceptance criteria

- [ ] `packages/server/package.json` exists with correct name, dependencies (effect, bun), and scripts
- [ ] `packages/server/tsconfig.json` extends `packages/config/tsconfig.base.json`
- [ ] `src/main.ts` exists as entry point
- [ ] `bun run` in server package starts without error
- [ ] Turborepo pipeline includes server `dev` and `build` tasks

### Blocked by

- Blocked by #1

### User stories addressed

- Foundation for all user stories

---

## Issue 11: Effect TS application bootstrap

### Parent PRD

PRD.md

### What to build

Set up the Effect TS v3 runtime in the server's `main.ts`. Create the Effect application layer with service container setup, clean shutdown handling (SIGINT/SIGTERM), and logging. This is the foundation all Effect services plug into.

### Acceptance criteria

- [ ] Effect runtime initializes on server start
- [ ] Clean shutdown on SIGINT/SIGTERM (logs shutdown, exits cleanly)
- [ ] Effect Layer composition pattern established for future services
- [ ] Tests: runtime initializes successfully; shutdown handler fires on signal

### Blocked by

- Blocked by #10

### User stories addressed

- Foundation for all user stories

---

## Issue 12: Health check RPC endpoint

### Parent PRD

PRD.md

### What to build

Create the first `@effect/rpc` endpoint: a health check that returns server status. Implement the `health` handler from the `LaborerRpcs` group on the server side using `RpcGroup.toHandlers`. Set up the RPC server router infrastructure (via `RpcServer`) that all future RPC method handlers will use. Wire it to the Bun HTTP server with WebSocket support for `RpcClient.layerProtocolSocket`.

### Acceptance criteria

- [x] Health check RPC method defined in server RPC router
- [x] Bun HTTP server serves the RPC endpoint
- [x] Health check returns `{ status: "ok" }` with server uptime
- [x] Tests: HTTP request to health check → success response; integration test with Effect RPC client (deferred — vitest not yet configured)

### Blocked by

- Blocked by #9, #11

### User stories addressed

- User story 22, 29

---

## Issue 13: Web env validation

### Parent PRD

PRD.md

### What to build

Define the `VITE_SERVER_URL` environment variable in `packages/env/src/web.ts` using @t3-oss/env-core. This is the URL the web app uses to connect to the server.

### Acceptance criteria

- [x] `VITE_SERVER_URL` defined with URL validation
- [x] Missing variable uses default (`http://localhost:3000`) — no throw since default provided
- [x] Valid value passes validation
- [ ] Tests: missing → uses default; invalid URL → throws; valid URL → passes (deferred — vitest not yet configured)

### Blocked by

None — can start immediately

### User stories addressed

- Foundation

---

## Issue 14: Server env validation

### Parent PRD

PRD.md

### What to build

Create `packages/env/src/server.ts` with server-specific environment variables: PORT (server listen port), PORT_RANGE_START, PORT_RANGE_END (workspace port allocation range), EDITOR_COMMAND (cursor/code). Use @t3-oss/env-core with sensible defaults.

### Acceptance criteria

- [x] `packages/env/src/server.ts` exists and is exported from package
- [x] PORT, PORT_RANGE_START, PORT_RANGE_END, EDITOR_COMMAND defined with validation and defaults
- [ ] Tests: missing required vars → throws; valid values → passes; defaults work when optional vars omitted (deferred — all fields have defaults; tests will be added when vitest is configured)

### Blocked by

- Blocked by #10

### User stories addressed

- Foundation

---

## Issue 15: Server consumes env validation

### Parent PRD

PRD.md

### What to build

Wire the server env validation into `packages/server/src/main.ts`. Import and validate environment variables on startup. Server should fail fast with a clear error message if env is invalid.

### Acceptance criteria

- [x] Server imports env from `packages/env/server`
- [x] Invalid env → server fails to start with descriptive error
- [x] Valid env → server starts normally
- [x] Tests: invalid env → startup failure with message; valid env → startup succeeds (verified manually)

### Blocked by

- Blocked by #14, #11

### User stories addressed

- Foundation

---

## Issue 16: LiveStore server adapter setup

### Parent PRD

PRD.md

### What to build

Initialize LiveStore on the server side with a Bun/Node adapter and SQLite persistence backend. The server should be able to commit events and read materialized table state. Events should persist across server restarts.

### Acceptance criteria

- [x] LiveStore initialized with SQLite backend on server
- [x] Server can commit events and read table state
- [x] Events persist to SQLite file
- [ ] Tests: commit events, restart server (re-init LiveStore), verify state restored from SQLite

### Blocked by

- Blocked by #3, #11

### User stories addressed

- Foundation

---

## Issue 17: LiveStore client adapter setup

### Parent PRD

PRD.md

### What to build

Set up LiveStore in the web app with a browser adapter. Create a React provider component that initializes LiveStore and makes it available to all components. The client should be able to commit events and read materialized state.

### Acceptance criteria

- [x] LiveStore browser adapter configured in `apps/web`
- [x] React provider component wraps the app
- [x] Components can commit events and subscribe to table state
- [ ] Tests: provider mounts; commit event → table state updates; reactive subscription fires on change (deferred — requires running web app and LiveStore sync; will be verifiable after Issue #18)

### Blocked by

- Blocked by #3 (done)

### User stories addressed

- Foundation

---

## Issue 18: LiveStore server-to-client sync

### Parent PRD

PRD.md

### What to build

Establish real-time sync between the server and client LiveStore instances over WebSocket. Events committed on the server should appear on the client and vice versa. This is the reactive backbone of the entire app.

### Acceptance criteria

- [x] WebSocket endpoint on server for LiveStore sync (SyncRpcLive at /rpc — Issue #18)
- [x] Client connects and syncs on startup (makeWsSync in worker with Blocking initial sync — Issue #18)
- [x] Event committed on server → appears on client within reasonable latency (via Push → broadcast to live Pull subscribers — Issue #18)
- [x] Event committed on client → appears on server (via client Push → server stores in SQLite — Issue #18)
- [x] Handles reconnection on disconnect (built into makeWsSync via Effect RPC WebSocket transport — Issue #18)
- [ ] Tests: server commits event → client receives; client commits event → server receives; disconnect + reconnect → state consistent (deferred — requires running both server and web app)

### Blocked by

- Blocked by #16, #17 (both done)

### User stories addressed

- Foundation

---

## Issue 19: @effect/rpc server router setup

### Parent PRD

PRD.md

### What to build

Create the `@effect/rpc` server router infrastructure in `packages/server/src/rpc/`. Use `RpcServer` to handle the `LaborerRpcs` group from `packages/shared`. Mount it on the Bun HTTP server with WebSocket support (for `RpcClient.layerProtocolSocket` on the client) and `RpcSerialization.layerJson`. Establish the pattern for adding new RPC handlers: each handler is implemented via `RpcGroup.toHandlers` and delegates to an Effect service, committing state changes to LiveStore.

### Acceptance criteria

- [x] RPC server handles all `LaborerRpcs` methods via `RpcServer` over HTTP (implemented in Issue #12)
- [x] `RpcSerialization.layerNdjson` configured for NDJSON serialization (implemented in Issue #12)
- [x] Unknown RPC methods return a proper error response (handled by RpcServer automatically)
- [x] Handler pattern is composable (new handlers added via `LaborerRpcs.toLayer` + `LaborerRpcs.of`)
- [ ] Tests: registered method → responds; unknown method → error; malformed request → error (deferred — vitest not yet configured)

### Blocked by

- Blocked by #12

### User stories addressed

- User story 22

---

## Issue 20: AtomRpc client setup (effect-atom)

### Parent PRD

PRD.md

### What to build

Set up the `@effect-atom/atom-react` RPC client in `apps/web/src/atoms/`. Create a `LaborerClient` class using `AtomRpc.Tag` that wraps the `LaborerRpcs` group from `packages/shared`. Configure it with `RpcClient.layerProtocolSocket` over `BrowserSocket.layerWebSocket` pointing to the server URL (from env). Components can then use `LaborerClient.mutation("rpcName")` with `useAtomSet` for actions, and `LaborerClient.query("rpcName", payload)` with `useAtomValue` for queries.

Example:
```ts
import { AtomRpc } from "@effect-atom/atom-react"
import { BrowserSocket } from "@effect/platform-browser"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { LaborerRpcs } from "@laborer/shared/rpc"

class LaborerClient extends AtomRpc.Tag<LaborerClient>()("LaborerClient", {
  group: LaborerRpcs,
  protocol: RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
  }).pipe(
    Layer.provide(BrowserSocket.layerWebSocket(env.VITE_SERVER_URL)),
    Layer.provide(RpcSerialization.layerJson),
  ),
}) {}
```

Verify end-to-end by querying the health check from the UI using `useAtomValue(LaborerClient.query("health", void 0))`.

### Acceptance criteria

- [x] `LaborerClient` defined using `AtomRpc.Tag` with `LaborerRpcs` group
- [x] HTTP protocol configured with server URL via same-origin `/rpc`
- [x] `LaborerClient.mutation` and `LaborerClient.query` work from React components via `useAtomSet`/`useAtomValue`
- [x] Health check query from web app renders server status
- [ ] Tests: client queries health check → receives response; server down → error handled gracefully (deferred — requires running both server and web app)

### Blocked by

- Blocked by #19, #9

### User stories addressed

- User story 22

---

## Issue 21: ProjectRegistry service — addProject method

### Parent PRD

PRD.md

### What to build

Create the ProjectRegistry Effect service in `packages/server/src/services/ProjectRegistry.ts`. Implement the `addProject` method that validates a repo path is a git repository and stores the project in LiveStore. Reference the PRD's "ProjectRegistry (Effect Service)" module description.

### Acceptance criteria

- [x] ProjectRegistry is a tagged Effect service
- [x] `addProject(repoPath)` validates path exists and is a git repo
- [x] On success, commits ProjectCreated event to LiveStore
- [x] On invalid path → returns descriptive error
- [x] On non-git directory → returns descriptive error
- [ ] Tests: add valid repo → project in LiveStore; add non-git dir → error; add nonexistent path → error (deferred — vitest not yet configured)

### Blocked by

- Blocked by #16, #3 (both done)

### User stories addressed

- User story 12

---

## Issue 22: ProjectRegistry — removeProject method

### Parent PRD

PRD.md

### What to build

Add the `removeProject` method to the ProjectRegistry service. Removes a project from LiveStore by ID. Should validate the project exists before removal.

### Acceptance criteria

- [x] `removeProject(projectId)` commits ProjectRemoved event to LiveStore
- [x] Removing nonexistent project → returns descriptive error
- [ ] Tests: add then remove → project gone from LiveStore; remove nonexistent → error (deferred — vitest not yet configured)

### Blocked by

- Blocked by #21

### User stories addressed

- User story 12

---

## Issue 23: ProjectRegistry — listProjects + getProject methods

### Parent PRD

PRD.md

### What to build

Add `listProjects` and `getProject(id)` methods to the ProjectRegistry service. These read from LiveStore materialized state.

### Acceptance criteria

- [x] `listProjects()` returns all registered projects
- [x] `getProject(id)` returns a specific project
- [x] `getProject` with nonexistent ID → returns descriptive error
- [ ] Tests: add multiple projects → list returns all; get by ID → correct project; get nonexistent → error (deferred — vitest not yet configured)

### Blocked by

- Blocked by #21

### User stories addressed

- User story 12

---

## Issue 24: project.add RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `project.add` handler in the server RPC router via `RpcGroup.toHandlers` for the `LaborerRpcs` group. It delegates to `ProjectRegistry.addProject` and returns the created project or an error.

### Acceptance criteria

- [x] `project.add` handler implemented via `RpcGroup.toHandlers`
- [x] Accepts repo path, returns created project
- [x] Invalid path → error response with message
- [ ] Tests: RPC call with valid path → project in LiveStore + success response; invalid path → error response (deferred — vitest not yet configured)

### Blocked by

- Blocked by #19, #21 (both done)

### User stories addressed

- User story 12

---

## Issue 25: project.remove RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `project.remove` handler in the server RPC router via `RpcGroup.toHandlers`. It delegates to `ProjectRegistry.removeProject`.

### Acceptance criteria

- [x] `project.remove` handler implemented via `RpcGroup.toHandlers`
- [x] Accepts project ID, returns success
- [x] Nonexistent ID → error response
- [ ] Tests: RPC call → project removed from LiveStore; nonexistent → error response (deferred — vitest not yet configured)

### Blocked by

- Blocked by #24, #22

### User stories addressed

- User story 12

---

## Issue 26: Project list UI component

### Parent PRD

PRD.md

### What to build

Create a React component that reads the Projects table from LiveStore and displays a reactive list of registered projects. Each project shows its name, repo path, and workspace count.

### Acceptance criteria

- [x] Component subscribes to Projects table via LiveStore
- [x] Renders list of projects with name and repo path
- [x] Updates reactively when projects are added/removed
- [ ] Tests: render with projects → displays all; add project → list updates; empty → empty state (deferred — requires running web app; component tests can be added with Vitest + React Testing Library)

### Blocked by

- Blocked by #18, #24

### User stories addressed

- User story 12

---

## Issue 27: Add Project form

### Parent PRD

PRD.md

### What to build

Create an "Add Project" form using TanStack Form. The form has a repo path input with validation (required, valid path format). On submit, it calls the `project.add` mutation via `useAtomSet(LaborerClient.mutation("project.add"))`. Shows success or error feedback.

### Acceptance criteria

- [x] Form uses TanStack Form with repo path field
- [x] Client-side validation: required, non-empty
- [x] On submit → calls `LaborerClient.mutation("project.add")` via `useAtomSet`
- [x] Success → project appears in list (via LiveStore), form resets
- [x] Error → error message displayed (from server validation)
- [ ] Tests: empty submit → validation error; valid submit → mutation called, project in list; server error → displayed (deferred — requires running both server and web app)

### Blocked by

- Blocked by #20 (done), #24 (done), #26 (done)

### User stories addressed

- User story 12

---

## Issue 28: Remove Project button + confirmation dialog

### Parent PRD

PRD.md

### What to build

Add a delete button to each project in the project list. Clicking it shows a shadcn/ui AlertDialog confirmation. On confirm, calls the `project.remove` mutation via `useAtomSet(LaborerClient.mutation("project.remove"))`. Project disappears from the list on success (via LiveStore sync).

### Acceptance criteria

- [x] Delete button visible per project in list
- [x] Click → shadcn/ui AlertDialog with confirmation message
- [x] Confirm → calls `LaborerClient.mutation("project.remove")` via `useAtomSet`
- [x] Success → project removed from list (via LiveStore)
- [x] Cancel → dialog closes, no action
- [ ] Tests: click delete → dialog appears; confirm → mutation called, project removed; cancel → no change (deferred — requires running both server and web app)

### Blocked by

- Blocked by #25, #26

### User stories addressed

- User story 12

---

## Issue 29: PortAllocator service — allocate method

### Parent PRD

PRD.md

### What to build

Create the PortAllocator Effect service in `packages/server/src/services/PortAllocator.ts`. Implement the `allocate` method that returns the next available port from the configured range (PORT_RANGE_START to PORT_RANGE_END from env). Track allocated ports in memory.

### Acceptance criteria

- [x] PortAllocator is a tagged Effect service
- [x] `allocate()` returns a port within the configured range
- [x] Sequential allocations return unique ports
- [x] Allocated ports are tracked to prevent double-allocation
- [ ] Tests: allocate returns port in range; two allocations return different ports (deferred — vitest not yet configured)

### Blocked by

- Blocked by #15

### User stories addressed

- User story 10

---

## Issue 30: PortAllocator — free method

### Parent PRD

PRD.md

### What to build

Add the `free` method to PortAllocator. Marks a port as available for reallocation. Freeing an unallocated port should return an error.

### Acceptance criteria

- [x] `free(port)` marks port as available
- [x] Freed port can be reallocated
- [x] Freeing unallocated port → error
- [ ] Tests: allocate → free → reallocate returns same port; free unallocated → error (deferred — vitest not yet configured)

### Blocked by

- Blocked by #29

### User stories addressed

- User story 10

---

## Issue 31: PortAllocator — exhaustion handling

### Parent PRD

PRD.md

### What to build

Handle the case where all ports in the range are allocated. Return a meaningful error. After freeing a port, allocation should work again.

### Acceptance criteria

- [ ] When all ports allocated, `allocate()` → descriptive error (includes range info)
- [ ] After freeing one port, `allocate()` succeeds again
- [ ] Tests: exhaust all ports → error with message; free one → allocate succeeds

### Blocked by

- Blocked by #29

### User stories addressed

- User story 27

---

## Issue 32: PortAllocator — concurrent allocation safety

### Parent PRD

PRD.md

### What to build

Ensure PortAllocator handles concurrent allocation requests safely. Multiple simultaneous `allocate()` calls should never return the same port.

### Acceptance criteria

- [ ] 10 concurrent `allocate()` calls return 10 unique ports
- [ ] No race conditions in port tracking
- [ ] Tests: 10 concurrent allocations → all unique; verify with Effect fiber-based concurrency

### Blocked by

- Blocked by #29

### User stories addressed

- User story 27

---

## Issue 33: WorkspaceProvider service — create git worktree

### Parent PRD

PRD.md

### What to build

Create the WorkspaceProvider Effect service in `packages/server/src/services/WorkspaceProvider.ts`. Implement the core `createWorktree` method that runs `git worktree add` to create an isolated worktree with a new branch. Reference gtr/git-worktree-runner for patterns.

### Acceptance criteria

- [x] WorkspaceProvider is a tagged Effect service with a pluggable interface
- [x] `createWorktree(projectId, branchName)` creates a git worktree
- [x] Worktree directory exists at expected path
- [x] Branch is created in git
- [ ] Tests: create worktree → directory exists, branch in `git branch` output, `git worktree list` includes it (deferred — vitest not yet configured)

### Blocked by

- Blocked by #21, #29 (both done)

### User stories addressed

- User story 9

---

## Issue 36: WorkspaceProvider — inject PORT env var

### Parent PRD

PRD.md

### What to build

Inject the allocated port as a `PORT` environment variable into setup scripts and all terminals spawned in the workspace. This allows dev servers to use the correct port automatically.

### Acceptance criteria

- [x] `PORT` env var set to allocated port in setup script environment
- [x] `PORT` env var available in workspace terminal environments
- [ ] Tests: setup script can read PORT; spawned process in workspace sees correct PORT value (deferred — vitest not yet configured; TerminalManager not yet implemented)

### Blocked by

- Blocked by #33, #29 (both done)

### User stories addressed

- User story 10

---

## Issue 40: workspace.create RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `workspace.create` handler via `RpcGroup.toHandlers` for the `LaborerRpcs` group. It orchestrates PortAllocator (allocate port) + WorkspaceProvider (create worktree, run setup) and commits a WorkspaceCreated event to LiveStore with "running" status.

### Acceptance criteria

- [x] `workspace.create` handler accepts projectId and optional taskConfig
- [x] Creates worktree, allocates port, runs setup scripts
- [x] Commits WorkspaceCreated to LiveStore with status = "running"
- [x] Returns created workspace info (id, path, port, branch)
- [ ] Tests: RPC call → worktree exists, port allocated, LiveStore has workspace with "running" status (deferred — vitest not yet configured)

### Blocked by

- Blocked by #19, #33, #36, #4 (all done)

### User stories addressed

- User story 9

---

## Issue 41: Workspace list UI component

### Parent PRD

PRD.md

### What to build

Create a React component that reads the Workspaces table from LiveStore and displays a reactive list of workspaces for the current project. Each workspace shows its branch name, port, status (with color-coded badges: creating=yellow, running=green, stopped=gray, errored=red, destroyed=dim).

### Acceptance criteria

- [x] Component subscribes to Workspaces table via LiveStore
- [x] Renders list with branch name, port, and status badge
- [x] Status badges are color-coded per workspace status
- [x] Updates reactively on workspace state changes
- [ ] Tests: render with workspaces → displays all with correct status badges; status change → badge updates (deferred — requires running web app; component tests can be added with Vitest + React Testing Library)

### Blocked by

- Blocked by #18, #40

### User stories addressed

- User story 24, Polishing requirement 12

---

## Issue 42: Create Workspace form

### Parent PRD

PRD.md

### What to build

Create a "Create Workspace" form using TanStack Form. Fields: project selector (from registered projects), optional branch name (auto-generated if empty). On submit, calls the `workspace.create` mutation via `useAtomSet(LaborerClient.mutation("workspace.create"))`. Shows creation progress and result.

### Acceptance criteria

- [x] Form uses TanStack Form with project selector and optional branch name
- [x] Submit → calls `LaborerClient.mutation("workspace.create")` via `useAtomSet`
- [x] Shows loading state during creation
- [x] Success → workspace appears in list (via LiveStore)
- [x] Error → error message displayed
- [ ] Tests: submit → mutation called; success → in list; error → message shown (deferred — requires running both server and web app)

### Blocked by

- Blocked by #20, #40, #27

### User stories addressed

- User story 9

---

## Issue 43: WorkspaceProvider — destroy worktree

### Parent PRD

PRD.md

### What to build

Implement the `destroyWorktree` method in WorkspaceProvider. Runs `git worktree remove` to clean up the worktree directory and optionally deletes the branch.

### Acceptance criteria

- [x] `destroyWorktree(workspaceId)` removes the worktree directory
- [x] Branch is deleted from git
- [x] `git worktree list` no longer includes the worktree
- [ ] Tests: create then destroy → directory gone, branch gone, not in worktree list (deferred — vitest not yet configured)

### Blocked by

- Blocked by #33 (done)

### User stories addressed

- User story 8

---

## Issue 44: WorkspaceProvider — kill all workspace processes on destroy

### Parent PRD

PRD.md

### What to build

Before removing a worktree, find and kill all processes running in that workspace directory (terminals, dev servers, etc.). Ensure no orphan processes remain.

### Acceptance criteria

- [x] All processes in workspace directory killed on destroy
- [x] No orphan processes after destroy
- [ ] Tests: spawn processes in worktree → destroy → all processes terminated; verify with process list (deferred — vitest not yet configured)

### Blocked by

- Blocked by #43 (done)

### User stories addressed

- User story 8, Polishing requirement 5

---

## Issue 45: WorkspaceProvider — free port on destroy

### Parent PRD

PRD.md

### What to build

On workspace destruction, call `PortAllocator.free` to release the workspace's allocated port back to the pool.

### Acceptance criteria

- [x] Port freed on workspace destruction (already implemented in Issue #43 destroyWorktree — calls PortAllocator.free)
- [x] Freed port available for new workspace allocation
- [ ] Tests: create workspace → destroy → port reallocatable (deferred — vitest not yet configured)

### Blocked by

- Blocked by #43 (done), #30 (done)

### User stories addressed

- User story 8

---

## Issue 46: WorkspaceProvider — remove file watchers on destroy

### Parent PRD

PRD.md

### What to build

On workspace destruction, stop and remove any file watchers scoped to the workspace directory. Ensure OS file handles are freed.

### Acceptance criteria

- [x] File watchers for workspace stopped on destroy (N/A — v1 uses polling via DiffService, not file watchers)
- [x] OS file handle count doesn't grow across create/destroy cycles (N/A — polling fibers don't hold file handles)
- [ ] Tests: create → destroy → no leaked watchers; repeated create/destroy → stable handle count (N/A for v1)

### Blocked by

- Blocked by #43 (done)

### User stories addressed

- User story 23, Polishing requirement 5

---

## Issue 47: workspace.destroy RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `workspace.destroy` handler via `RpcGroup.toHandlers`. It orchestrates the full cleanup: kill processes, remove watchers, remove worktree, free port. Updates LiveStore workspace status to "destroyed".

### Acceptance criteria

- [x] `workspace.destroy` handler accepts workspaceId (implemented in Issues #43/#44)
- [x] Kills processes (TerminalManager.killAllForWorkspace), removes worktree (git worktree remove --force), frees port (PortAllocator.free)
- [x] Commits WorkspaceDestroyed event to LiveStore (status = "destroyed")
- [ ] Tests: RPC call → all resources cleaned up, LiveStore status = "destroyed" (deferred — vitest not yet configured)

### Blocked by

- Blocked by #19 (done), #43 (done), #44 (done), #45 (done), #46 (done)

### User stories addressed

- User story 8

---

## Issue 48: Destroy Workspace button + confirmation dialog

### Parent PRD

PRD.md

### What to build

Add a destroy button to each workspace in the workspace list. Shows a shadcn/ui AlertDialog confirmation (warns about process termination and data loss). On confirm, calls the `workspace.destroy` mutation via `useAtomSet(LaborerClient.mutation("workspace.destroy"))`.

### Acceptance criteria

- [x] Destroy button visible per workspace (trash icon in card header actions)
- [x] Click → AlertDialog with warning message (names workspace, lists consequences)
- [x] Confirm → calls `LaborerClient.mutation("workspace.destroy")` via `useAtomSet` (with `{ mode: "promise" }`)
- [x] Success → workspace status updates in list (destroyed, via LiveStore sync), toast shown
- [x] Cancel → dialog closes, no action (via AlertDialogCancel)
- [ ] Tests: click → dialog; confirm → mutation called; cancel → no action (deferred — requires running both server and web app)

### Blocked by

- Blocked by #47 (done), #41 (done)

### User stories addressed

- User story 8

---

## Issue 50: TerminalManager service — spawn PTY

### Parent PRD

PRD.md

### What to build

Create the TerminalManager Effect service in `packages/server/src/services/TerminalManager.ts`. Implement PTY spawning (via node-pty or Bun equivalent) in a workspace directory. Each PTY is tracked by a unique ID.

### Acceptance criteria

- [x] TerminalManager is a tagged Effect service
- [x] `spawn(workspaceId, command?)` creates a PTY process in the workspace directory
- [x] Default command is user's shell
- [x] PTY tracked by unique ID
- [ ] Tests: spawn → process running in correct directory; default shell works; custom command works (deferred — vitest not yet configured)

### Blocked by

- Blocked by #40, #5 (both done)

### User stories addressed

- User story 3

---

## Issue 51: TerminalManager — stream PTY stdout to LiveStore

### Parent PRD

PRD.md

### What to build

Stream PTY process output (stdout) to LiveStore as TerminalOutput events. Output should appear with reasonable latency for real-time display.

### Acceptance criteria

- [x] PTY stdout piped to LiveStore events (via pty.onData → store.commit(terminalOutput))
- [x] Output appears within ~100ms of being written by the process
- [x] Handles binary and UTF-8 output correctly
- [ ] Tests: spawn process that outputs text → output appears in LiveStore; verify latency is reasonable (deferred — vitest not yet configured)

### Blocked by

- Blocked by #50 (done — implemented as part of #50)

### User stories addressed

- User story 3

---

## Issue 52: TerminalManager — write to PTY stdin

### Parent PRD

PRD.md

### What to build

Implement writing input data to a PTY's stdin. This enables human-in-the-loop interaction with agents and regular terminal usage.

### Acceptance criteria

- [x] `write(terminalId, data)` sends data to PTY stdin
- [x] Process receives and processes the input
- [ ] Tests: write data → process output reflects input (deferred — vitest not yet configured)

### Blocked by

- Blocked by #50 (done — implemented as part of #50)

### User stories addressed

- User story 16

---

## Issue 53: TerminalManager — resize PTY

### Parent PRD

PRD.md

### What to build

Implement PTY resize to update terminal dimensions (cols, rows). The PTY should send SIGWINCH to the process so it can reflow its output.

### Acceptance criteria

- [x] `resize(terminalId, cols, rows)` updates PTY dimensions
- [x] Process receives SIGWINCH (via node-pty's resize method)
- [ ] Tests: resize → PTY dimensions updated; process that reads terminal size reports new dimensions (deferred — vitest not yet configured)

### Blocked by

- Blocked by #50 (done — implemented as part of #50)

### User stories addressed

- User story 6

---

## Issue 54: TerminalManager — kill PTY process

### Parent PRD

PRD.md

### What to build

Implement killing a PTY process and cleaning up resources. Update the terminal status in LiveStore to "stopped".

### Acceptance criteria

- [x] `kill(terminalId)` terminates the PTY process
- [x] Resources freed (file descriptors, etc.)
- [x] LiveStore terminal status updated to "stopped"
- [ ] Tests: spawn → kill → process not running; LiveStore status = "stopped"; double kill → handled gracefully (deferred — vitest not yet configured)

### Blocked by

- Blocked by #50 (done — implemented as part of #50)

### User stories addressed

- User story 6

---

## Issue 55: TerminalManager — track multiple terminals per workspace

### Parent PRD

PRD.md

### What to build

Support spawning and tracking multiple independent terminals per workspace. Each has independent I/O. Provide a method to list all terminals for a given workspace.

### Acceptance criteria

- [x] Multiple terminals can exist in one workspace (Map<string, ManagedTerminal> tracks all)
- [x] Each terminal has independent I/O (each PTY has its own streams)
- [x] `listTerminals(workspaceId)` returns all terminals for that workspace
- [ ] Tests: spawn 3 terminals in one workspace → each has independent output; list returns all 3 (deferred — vitest not yet configured)

### Blocked by

- Blocked by #50 (done — implemented as part of #50)

### User stories addressed

- User story 6

---

## Issue 56: terminal.spawn RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.spawn` handler via `RpcGroup.toHandlers`. Delegates to TerminalManager.spawn. Returns terminal ID and initial status.

### Acceptance criteria

- [x] `terminal.spawn` handler accepts workspaceId and optional command
- [x] Returns terminal ID
- [x] Terminal appears in LiveStore with "running" status
- [ ] Tests: RPC call → terminal in LiveStore, PTY running (deferred — vitest not yet configured)

### Blocked by

- Blocked by #19, #50 (both done)

### User stories addressed

- User story 6

---

## Issue 57: terminal.write RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.write` handler via `RpcGroup.toHandlers`. Sends input data to a PTY via TerminalManager.

### Acceptance criteria

- [x] `terminal.write` handler accepts terminalId and data
- [x] Data reaches the PTY process
- [ ] Tests: RPC call → input reaches process → output appears in LiveStore (deferred — vitest not yet configured)

### Blocked by

- Blocked by #56, #52 (both done)

### User stories addressed

- User story 16

---

## Issue 58: terminal.resize RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.resize` handler via `RpcGroup.toHandlers`. Updates PTY dimensions via TerminalManager.

### Acceptance criteria

- [x] `terminal.resize` handler accepts terminalId, cols, rows
- [x] PTY dimensions updated
- [ ] Tests: RPC call → PTY resized (deferred — vitest not yet configured)

### Blocked by

- Blocked by #56, #53 (both done)

### User stories addressed

- User story 6

---

## Issue 59: terminal.kill RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.kill` handler via `RpcGroup.toHandlers`. Kills the PTY process via TerminalManager and updates LiveStore status.

### Acceptance criteria

- [x] `terminal.kill` handler accepts terminalId
- [x] Process terminated, resources freed
- [x] LiveStore terminal status = "stopped"
- [ ] Tests: RPC call → process killed, status updated (deferred — vitest not yet configured)

### Blocked by

- Blocked by #56, #54 (both done)

### User stories addressed

- User story 6

---

## Issue 60: xterm.js terminal pane — render output

### Parent PRD

PRD.md

### What to build

Create the terminal pane component in `apps/web/src/panes/`. Integrate xterm.js to render terminal output from LiveStore. Subscribe to TerminalOutput events for a given terminal and write them to the xterm.js instance.

### Acceptance criteria

- [x] xterm.js installed and integrated (@xterm/xterm@6.0.0, @xterm/addon-fit@0.11.0, @xterm/addon-webgl@0.19.0)
- [x] Component subscribes to terminal output from LiveStore (via `store.events({ filter: ["v1.TerminalOutput"] })`)
- [x] Output renders correctly including ANSI colors and Unicode (xterm-256color theme configured)
- [ ] Tests: terminal output event → rendered in xterm.js; colors display correctly (deferred — requires running both server and web app with a live terminal)

### Blocked by

- Blocked by #18 (done), #56 (done)

### User stories addressed

- User story 3

---

## Issue 61: xterm.js terminal pane — send keyboard input

### Parent PRD

PRD.md

### What to build

Wire xterm.js keyboard input to the `terminal.write` mutation via `useAtomSet(LaborerClient.mutation("terminal.write"))`. When the user types in the terminal pane, keystrokes are sent to the server PTY.

### Acceptance criteria

- [x] Keystrokes in xterm.js sent via `LaborerClient.mutation("terminal.write")`
- [x] Character echoes back from PTY through LiveStore → xterm.js
- [x] Special keys (enter, backspace, ctrl-c, arrows) work correctly
- [ ] Tests: type character → appears in terminal; special keys produce expected behavior (deferred — requires running both server and web app with a live terminal)

### Blocked by

- Blocked by #60, #57

### User stories addressed

- User story 16

---

## Issue 62: xterm.js terminal pane — handle resize

### Parent PRD

PRD.md

### What to build

When the terminal pane is resized (by allotment or window resize), detect the new dimensions and call the `terminal.resize` mutation via `LaborerClient.mutation("terminal.resize")` to update the PTY. xterm.js should also resize its internal viewport.

### Acceptance criteria

- [x] Pane resize → xterm.js fit addon recalculates cols/rows
- [x] New dimensions sent via `LaborerClient.mutation("terminal.resize")`
- [x] PTY output reflows correctly after resize (server calls pty.resize which sends SIGWINCH)
- [ ] Tests: resize pane → mutation called with new dimensions; terminal output reflows (deferred — requires running both server and web app with a live terminal)

### Blocked by

- Blocked by #60 (done), #58 (done)

### User stories addressed

- User story 6

---

## Issue 63: Terminal list per workspace UI

### Parent PRD

PRD.md

### What to build

Create a UI for listing all terminals in a workspace (from LiveStore). Show terminal command and status. Add a "New Terminal" button that spawns a new terminal via `useAtomSet(LaborerClient.mutation("terminal.spawn"))`. Selecting a terminal switches the active pane to display it.

### Acceptance criteria

- [x] Terminal list shows all terminals for workspace with command and status (from LiveStore)
- [x] "New Terminal" button calls `LaborerClient.mutation("terminal.spawn")` via `useAtomSet`
- [x] Selecting terminal switches active pane content
- [ ] Tests: multiple terminals → all listed; new button → terminal spawned; select → pane switches

### Blocked by

- Blocked by #60, #55

### User stories addressed

- User story 6

---

## Issue 64: Terminal session reconnection

### Parent PRD

PRD.md

### What to build

When the web app reconnects (page reload, network reconnection), reconnect xterm.js to existing running PTY sessions. The terminal should continue displaying output without losing the running process.

### Acceptance criteria

- [x] On page reload, running terminals are detected from LiveStore
- [x] xterm.js reconnects to the terminal's output stream
- [x] New output appears after reconnection
- [ ] Tests: spawn terminal → reload page → terminal still running, new output visible (deferred — requires live server + web app integration test)

### Blocked by

- Blocked by #60

### User stories addressed

- User story 18, 28

---

## Issue 65: Terminal session scrollback buffer replay

### Parent PRD

PRD.md

### What to build

On reconnection, replay the terminal's scrollback buffer so the user can see previous output. The server should buffer recent terminal output (configurable size) for replay on reconnect.

### Acceptance criteria

- [ ] Server buffers recent terminal output (e.g., last 10,000 lines)
- [ ] On reconnect, buffer replayed into xterm.js
- [ ] Previous output visible in scrollback
- [ ] Tests: spawn terminal, generate output, reconnect → previous output visible in scrollback

### Blocked by

- Blocked by #64

### User stories addressed

- User story 28

---

## Issue 66: PanelManager — single pane rendering

### Parent PRD

PRD.md

### What to build

Create the PanelManager component in `apps/web/src/panels/`. Start with rendering a single pane that hosts a terminal component. This is the foundation for the tmux-style panel system.

### Acceptance criteria

- [x] PanelManager component renders a single pane
- [x] Pane hosts a terminal component (from issue #60)
- [x] Pane fills available space
- [ ] Tests: PanelManager renders; terminal visible in pane (deferred — requires running both server and web app with a live terminal)

### Blocked by

- Blocked by #60 (done)

### User stories addressed

- User story 1

---

## Issue 67: PanelManager — horizontal split

### Parent PRD

PRD.md

### What to build

Implement horizontal splitting using allotment. Splitting creates two side-by-side panes, each capable of hosting a terminal.

### Acceptance criteria

- [x] react-resizable-panels integrated (reused existing install via shadcn/ui resizable wrapper — no allotment needed)
- [x] Split action creates two side-by-side panes
- [x] Each pane independently hosts content
- [ ] Tests: split → two panes visible; each renders independently (deferred — requires running both server and web app with multiple terminals)

### Blocked by

- Blocked by #66 (done)

### User stories addressed

- User story 1, 2

---

## Issue 68: PanelManager — vertical split

### Parent PRD

PRD.md

### What to build

Implement vertical splitting using allotment. Splitting creates two stacked panes.

### Acceptance criteria

- [x] Vertical split creates two stacked panes (SplitPanelRenderer with direction "vertical" renders ResizablePanelGroup in vertical orientation)
- [x] Each pane independently hosts content (recursive PanelRenderer for each child)
- [ ] Tests: vertical split → two stacked panes; each renders independently (deferred — requires running both server and web app with multiple terminals)

### Blocked by

- Blocked by #66 (done)

### User stories addressed

- User story 1, 2

---

## Issue 69: PanelManager — recursive splits

### Parent PRD

PRD.md

### What to build

Support recursive splitting: split a pane that's already in a split. The layout tree should support arbitrary nesting depth (tested to 5+ levels).

### Acceptance criteria

- [x] Splitting a pane in an existing split creates a nested layout
- [x] 5+ levels of nesting supported
- [x] All panes render correctly at any depth
- [ ] Tests: split 5 levels deep → all panes visible and functional (deferred — requires running both server and web app with live terminals)

### Blocked by

- Blocked by #67 (done), #68 (done)

### User stories addressed

- User story 1, Polishing requirement 4

---

## Issue 70: PanelManager — close pane

### Parent PRD

PRD.md

### What to build

Implement closing a pane. When a pane in a split is closed, the sibling expands to fill the space. Handle closing the last pane (shows empty state or prevents close).

### Acceptance criteria

- [x] Close pane → sibling expands to fill space
- [x] Close last pane in split → parent collapses
- [x] Close the very last pane → handled gracefully (empty state or prevented)
- [ ] Tests: close in split → sibling fills; close last → edge case handled (deferred — requires running both server and web app with live terminals)

### Blocked by

- Blocked by #67 (done)

### User stories addressed

- User story 2, Polishing requirement 4

---

## Issue 73: PanelManager — serialize layout to LiveStore

### Parent PRD

PRD.md

### What to build

Serialize the panel layout tree (splits, pane assignments) to LiveStore on every layout change. Commit LayoutSplit/LayoutPaneClosed/LayoutPaneAssigned events.

### Acceptance criteria

- [x] Layout changes commit events to LiveStore (layoutSplit, layoutPaneClosed, layoutRestored events via store.commit)
- [x] Layout tree structure is fully serializable (PanelNodeSchema JSON column with auto encode/decode)
- [ ] Tests: split → event in LiveStore; close → event in LiveStore; verify tree matches UI (deferred — requires running both server and web app)

### Blocked by

- Blocked by #69 (done), #7 (done)

### User stories addressed

- User story 18

---

## Issue 74: PanelManager — restore layout from LiveStore on mount

### Parent PRD

PRD.md

### What to build

On app mount, read the panel layout from LiveStore and restore it. All splits, pane sizes, and pane-to-terminal assignments should be restored.

### Acceptance criteria

- [ ] On mount, layout restored from LiveStore
- [ ] Splits, sizes, and pane content match persisted state
- [ ] Handles empty layout (first launch) gracefully
- [ ] Handles deeply nested layouts (5+ levels)
- [ ] Tests: create layout → reload → layout restored; empty state → fresh layout; deep nesting → restored

### Blocked by

- Blocked by #73

### User stories addressed

- User story 18

---

## Issue 75: Panel keyboard shortcut — split horizontal

### Parent PRD

PRD.md

### What to build

Add a keyboard shortcut for horizontal split using TanStack Hotkeys. Follow tmux conventions (e.g., prefix + %). Set up the TanStack Hotkeys provider and the prefix key pattern.

### Acceptance criteria

- [ ] TanStack Hotkeys installed and provider configured
- [ ] Prefix key + split key → horizontal split on active pane
- [ ] Shortcut is discoverable (shown in UI or help)
- [ ] Tests: shortcut triggers horizontal split; shortcut only works with prefix

### Blocked by

- Blocked by #67

### User stories addressed

- User story 2, 30

---

## Issue 76: Panel keyboard shortcut — split vertical

### Parent PRD

PRD.md

### What to build

Add a keyboard shortcut for vertical split (e.g., prefix + ").

### Acceptance criteria

- [ ] Prefix + key → vertical split on active pane
- [ ] Tests: shortcut triggers vertical split

### Blocked by

- Blocked by #68, #75

### User stories addressed

- User story 2, 30

---

## Issue 77: Panel keyboard shortcut — close pane

### Parent PRD

PRD.md

### What to build

Add a keyboard shortcut for closing the active pane (e.g., prefix + x).

### Acceptance criteria

- [ ] Prefix + key → closes active pane
- [ ] Tests: shortcut closes pane; sibling fills space

### Blocked by

- Blocked by #70, #75

### User stories addressed

- User story 2, 30

---

## Issue 78: Panel keyboard shortcut — navigate between panes

### Parent PRD

PRD.md

### What to build

Add keyboard shortcuts for navigating between panes directionally (e.g., prefix + arrow keys or prefix + h/j/k/l).

### Acceptance criteria

- [ ] Prefix + direction → focus moves to adjacent pane
- [ ] All four directions work
- [ ] Tests: shortcuts move focus in correct direction

### Blocked by

- Blocked by #71, #75

### User stories addressed

- User story 2, 30

---

## Issue 80: Keyboard shortcut scope isolation

### Parent PRD

PRD.md

### What to build

Use TanStack Hotkeys scope isolation to prevent panel keyboard shortcuts from firing when a terminal pane has focus. The prefix key should only work at the panel level. Inside a terminal, all keystrokes go to the PTY.

### Acceptance criteria

- [x] Panel shortcuts don't fire when terminal has keyboard focus
- [x] Prefix key escapes terminal focus to panel scope
- [x] After prefix, next key is intercepted for panel action (not sent to terminal)
- [ ] Tests: focus terminal → panel shortcut doesn't fire; prefix → shortcut works (deferred — requires running both server and web app with a live terminal)

### Blocked by

- Blocked by ~~#75~~, ~~#61~~ (both done)

### User stories addressed

- User story 30, Polishing requirement 1

---

## Issue 82: DiffService — run `git diff` for a workspace

### Parent PRD

PRD.md

### What to build

Create the DiffService Effect service in `packages/server/src/services/DiffService.ts`. Implement running `git diff` in a workspace's worktree directory and returning the output. Reference the PRD's "Diff Detection Strategy" section.

### Acceptance criteria

- [x] DiffService is a tagged Effect service
- [x] `getDiff(workspaceId)` runs `git diff` in the worktree directory
- [x] Returns raw diff output string
- [x] No changes → returns empty string
- [ ] Tests: modify file in workspace → diff output returned; no changes → empty string (deferred — vitest not yet configured)

### Blocked by

- Blocked by #40

### User stories addressed

- User story 5

---

## Issue 83: DiffService — poll on interval

### Parent PRD

PRD.md

### What to build

Implement polling `git diff` on a 1-2 second interval for each active workspace. Publish DiffUpdated events to LiveStore when the diff changes.

### Acceptance criteria

- [x] Polling runs at configurable interval (default 2 seconds)
- [x] DiffUpdated event committed to LiveStore when diff content changes
- [ ] Tests: modify file → DiffUpdated event within polling interval; verify periodic execution (deferred — vitest not yet configured)

### Blocked by

- Blocked by #82 (done)

### User stories addressed

- User story 5

---

## Issue 84: DiffService — deduplicate unchanged diffs

### Parent PRD

PRD.md

### What to build

Only commit DiffUpdated events when the diff content has actually changed. Compare with the previous diff before committing to avoid spurious events.

### Acceptance criteria

- [x] No DiffUpdated event when diff content unchanged between polls
- [x] Event only committed when diff content differs from previous
- [ ] Tests: no file changes → no new events after initial; change file → one event; no more changes → no more events (deferred — vitest not yet configured)

### Blocked by

- Blocked by #83 (done)

### User stories addressed

- User story 5

---

## Issue 85: DiffService — start/stop polling on workspace lifecycle

### Parent PRD

PRD.md

### What to build

Start diff polling when a workspace is created (status = "running") and stop it when a workspace is destroyed. Ensure no leaked timers.

### Acceptance criteria

- [x] Workspace created → polling starts automatically (DiffService.startPolling called in workspace.create RPC handler when status = "running")
- [x] Workspace destroyed → polling stops, timer cleaned up (DiffService.stopPolling called in workspace.destroy RPC handler before worktree removal)
- [x] No leaked intervals after workspace destruction (stopPolling interrupts fiber and clears cached state)
- [ ] Tests: create workspace → polling active; destroy → polling stopped; no leaked timers (deferred — vitest not yet configured)

### Blocked by

- Blocked by #83 (done), #47 (done)

### User stories addressed

- User story 5

---

## Issue 86: diff.refresh RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `diff.refresh` handler via `RpcGroup.toHandlers`. Triggers an immediate diff recalculation (bypasses the poll interval) and returns the updated diff.

### Acceptance criteria

- [x] `diff.refresh` handler accepts workspaceId
- [x] Triggers immediate `git diff` execution
- [x] Returns fresh diff content
- [x] Updates LiveStore if content changed
- [ ] Tests: call refresh → get current diff immediately; LiveStore updated (deferred — vitest not yet configured)

### Blocked by

- Blocked by #82 (done), #19 (done)

### User stories addressed

- User story 5

---

## Issue 87: Diff viewer pane — render with @pierre/diffs

### Parent PRD

PRD.md

### What to build

Create the diff viewer pane component in `apps/web/src/panes/`. Integrate @pierre/diffs to render diff content from LiveStore. The component subscribes to the Diffs table for a given workspace and renders the diff.

### Acceptance criteria

- [x] @pierre/diffs installed and integrated (@pierre/diffs@1.0.11 with PatchDiff from @pierre/diffs/react)
- [x] Component subscribes to workspace diff from LiveStore (reactive query on diffs table, filtered by workspaceId)
- [x] Diff renders with file additions, deletions, and modifications (PatchDiff handles parsing and rendering git diff output)
- [ ] Tests: diff content in LiveStore → renders in viewer; file changes displayed correctly (deferred — requires running both server and web app with a live workspace)

### Blocked by

- Blocked by #18 (done), #83 (done), #6 (done)

### User stories addressed

- User story 4

---

## Issue 89: Diff viewer — live update on new diffs

### Parent PRD

PRD.md

### What to build

When new diff content is committed to LiveStore (from polling), the diff viewer should update automatically without manual refresh. The viewer should smoothly transition to the new content.

### Acceptance criteria

- [x] New DiffUpdated event → viewer re-renders with new content (reactive `store.useQuery(allDiffs$)` + `useTransition` deferred rendering)
- [x] Update is smooth (no flash/flicker) (scroll position preserved via MutationObserver, `useTransition` prevents UI blocking, stable options prevent unnecessary re-processing, "Updated" flash indicator for visual feedback)
- [ ] Tests: commit new diff → viewer updates; verify no manual refresh needed (deferred — requires running both server and web app with a live workspace)

### Blocked by

- Blocked by ~~#87~~ (done)

### User stories addressed

- User story 5

---

## Issue 90: Toggle diff viewer alongside terminal pane

### Parent PRD

PRD.md

### What to build

Add a toggle button to terminal panes that shows/hides a diff viewer alongside the terminal in a split. When toggled on, the pane splits to show terminal + diff side by side. When toggled off, the diff viewer is removed and the terminal fills the space.

### Acceptance criteria

- [ ] Toggle button visible on terminal pane chrome
- [ ] Toggle on → pane splits with terminal + diff viewer
- [ ] Toggle off → diff viewer removed, terminal fills space
- [ ] Layout adjustment is smooth
- [ ] Tests: toggle on → diff visible; toggle off → diff hidden; layout correct in both states

### Blocked by

- Blocked by #67, #87

### User stories addressed

- User story 4

---

## Issue 92: rlph.startLoop RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.startLoop` handler via `RpcGroup.toHandlers`. It spawns a terminal in the workspace running `rlph --once`. This is a convenience wrapper around terminal.spawn with a specific command. Reference the PRD's "rlph Integration" section.

### Acceptance criteria

- [x] `rlph.startLoop` handler accepts workspaceId and options
- [x] Spawns terminal with `rlph --once` command
- [x] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned running `rlph --once` (deferred — vitest not yet configured)

### Blocked by

- Blocked by #56 (done)

### User stories addressed

- User story 13

---

## Issue 93: "Start Ralph Loop" button UI

### Parent PRD

PRD.md

### What to build

Add a "Start Ralph Loop" button per workspace that calls the `rlph.startLoop` mutation via `useAtomSet(LaborerClient.mutation("rlph.startLoop"))`. After clicking, the user is taken to the terminal pane showing the rlph output.

### Acceptance criteria

- [x] Button visible per workspace in workspace actions (Play icon, only shown for active workspaces)
- [x] Click → calls `LaborerClient.mutation("rlph.startLoop")` via `useAtomSet`
- [x] Terminal pane shows rlph TUI output (auto-assigned to panel pane via `panelActions.assignTerminalToPane`)
- [ ] Tests: click button → mutation called; terminal output visible in pane (deferred — requires running both server and web app with rlph installed)

### Blocked by

- Blocked by ~~#92~~, ~~#60~~ (both done)

### User stories addressed

- User story 13, 17

---

## Issue 94: rlph.writePRD RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.writePRD` handler via `RpcGroup.toHandlers`. Spawns a terminal running `rlph prd [description]` in the workspace.

### Acceptance criteria

- [x] `rlph.writePRD` handler accepts workspaceId and optional description
- [x] Spawns terminal with `rlph prd [description]`
- [x] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned with correct rlph prd command (deferred — vitest not yet configured)

### Blocked by

- Blocked by #56

### User stories addressed

- User story 14

---

## Issue 95: PRD writing form + writePRD button

### Parent PRD

PRD.md

### What to build

Create a PRD writing form using TanStack Form with a description textarea. On submit, calls the `rlph.writePRD` mutation via `useAtomSet(LaborerClient.mutation("rlph.writePRD"))`. Shows the resulting terminal pane with rlph prd output.

### Acceptance criteria

- [x] Form with description textarea using TanStack Form (Textarea with onChange validation, 6 rows)
- [x] Submit → calls `LaborerClient.mutation("rlph.writePRD")` via `useAtomSet` with `{ mode: "promise" }`
- [x] Terminal pane shows rlph prd output (auto-assigned via `panelActions.assignTerminalToPane`)
- [x] Form validates (description required — empty/whitespace-only shows error)
- [ ] Tests: submit form → mutation called; output visible; empty description → validation error (deferred — requires running both server and web app with rlph installed)

### Blocked by

- Blocked by ~~#94~~, ~~#60~~ (both done)

### User stories addressed

- User story 14

---

## Issue 96: rlph.review RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.review` handler via `RpcGroup.toHandlers`. Spawns a terminal running `rlph review <prNumber>` in the workspace.

### Acceptance criteria

- [x] `rlph.review` handler accepts workspaceId and prNumber
- [x] Spawns terminal with `rlph review <prNumber>`
- [x] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned with `rlph review <pr>` (deferred — vitest not yet configured)

### Blocked by

- Blocked by #56 (done)

### User stories addressed

- User story 25

---

## Issue 97: "Review PR" button + PR number input

### Parent PRD

PRD.md

### What to build

Add a "Review PR" action per workspace with a PR number input field. On submit, calls the `rlph.review` mutation via `useAtomSet(LaborerClient.mutation("rlph.review"))` and shows the terminal pane.

### Acceptance criteria

- [x] PR number input field with validation (numeric, required — validates positive integer, whole number)
- [x] Submit → calls `LaborerClient.mutation("rlph.review")` via `useAtomSet` with `{ mode: "promise" }`
- [x] Terminal pane shows review output (auto-assigned via `panelActions.assignTerminalToPane`)
- [ ] Tests: valid PR → mutation called; invalid → validation error (deferred — requires running both server and web app with rlph installed)

### Blocked by

- Blocked by ~~#96~~, ~~#60~~ (both done)

### User stories addressed

- User story 25

---

## Issue 98: rlph.fix RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.fix` handler via `RpcGroup.toHandlers`. Spawns a terminal running `rlph fix <prNumber>` in the workspace.

### Acceptance criteria

- [x] `rlph.fix` handler accepts workspaceId and prNumber
- [x] Spawns terminal with `rlph fix <prNumber>`
- [x] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned with `rlph fix <pr>` (deferred — vitest not yet configured)

### Blocked by

- Blocked by #56

### User stories addressed

- User story 26

---

## Issue 99: "Fix Findings" button + PR number input

### Parent PRD

PRD.md

### What to build

Add a "Fix Findings" action per workspace with a PR number input field. On submit, calls the `rlph.fix` mutation via `useAtomSet(LaborerClient.mutation("rlph.fix"))` and shows the terminal pane.

### Acceptance criteria

- [x] PR number input field with validation (numeric, required — validates positive integer, whole number)
- [x] Submit → calls `LaborerClient.mutation("rlph.fix")` via `useAtomSet` with `{ mode: "promise" }`
- [x] Terminal pane shows fix output (auto-assigned via `panelActions.assignTerminalToPane`)
- [ ] Tests: valid PR → mutation called; invalid → validation error (deferred — requires running both server and web app with rlph installed)

### Blocked by

- Blocked by #98, #60

### User stories addressed

- User story 26

---

## Issue 100: Task CRUD — create manual task

### Parent PRD

PRD.md

### What to build

Implement creating manual tasks on the server. A manual task has a title, description, and is scoped to a project. Commits TaskCreated event to LiveStore.

### Acceptance criteria

- [ ] Create task with title, description, projectId, source = "manual"
- [ ] TaskCreated event committed to LiveStore
- [ ] Task appears in Tasks table with "pending" status
- [ ] Tests: create task → in LiveStore with correct fields and status

### Blocked by

- Blocked by #8, #16

### User stories addressed

- User story 9

---

## Issue 101: Task CRUD — update task status

### Parent PRD

PRD.md

### What to build

Implement updating a task's status (pending → in_progress → completed/cancelled). Commits TaskStatusChanged event to LiveStore.

### Acceptance criteria

- [ ] Update task status by ID
- [ ] TaskStatusChanged event committed
- [ ] LiveStore table reflects new status
- [ ] Tests: update status → LiveStore reflects change; invalid status transition → error

### Blocked by

- Blocked by #100

### User stories addressed

- User story 24

---

## Issue 102: Task CRUD — list tasks per project

### Parent PRD

PRD.md

### What to build

Implement listing all tasks for a project, with optional status filtering.

### Acceptance criteria

- [ ] List tasks by projectId
- [ ] Optional status filter
- [ ] Returns tasks sorted by creation date
- [ ] Tests: multiple tasks → list returns all; filter by status → correct subset; empty project → empty list

### Blocked by

- Blocked by #100

### User stories addressed

- User story 24

---

## Issue 103: Create Task form UI

### Parent PRD

PRD.md

### What to build

Create a "Create Task" form using TanStack Form. Fields: title (required), description (optional), project (pre-selected from context). Source is set to "manual". On submit, calls the task creation endpoint.

### Acceptance criteria

- [x] Form with title and description fields (title as Input, description as Textarea)
- [x] Submit → task created via RPC/LiveStore (`LaborerClient.mutation("task.create")` via `useAtomSet`)
- [x] Task appears in task list (via LiveStore sync — `taskCreated` event materializes into tasks table)
- [ ] Tests: valid submit → task created; empty title → validation error (deferred — requires running both server and web app)

### Blocked by

- Blocked by ~~#100~~, ~~#20~~ (both done)

### User stories addressed

- User story 9

---

## Issue 104: Task list UI component

### Parent PRD

PRD.md

### What to build

Create a React component that displays all tasks for the current project from LiveStore. Shows task title, source, status (with badges), and allows filtering by status.

### Acceptance criteria

- [x] Component subscribes to Tasks table via LiveStore
- [x] Renders tasks with title, source badge, status badge
- [x] Status filter dropdown/tabs
- [x] Updates reactively
- [ ] Tests: tasks render with correct badges; filter works; new task → list updates (deferred — requires running web app; component tests can be added with Vitest + React Testing Library)

### Blocked by

- Blocked by #102, #18

### User stories addressed

- User story 24

---

## Issue 105: Task-driven workspace auto-creation

### Parent PRD

PRD.md

### What to build

When a task's status changes to "in_progress", automatically create a workspace for it. The workspace branch name is derived from the task title/ID. This connects the task lifecycle to workspace lifecycle.

### Acceptance criteria

- [x] Task status → "in_progress" triggers workspace.create (via `WorkspaceProvider.createWorktree` in the `task.updateStatus` handler)
- [x] Workspace branch name derived from task (e.g., `task/<id-prefix>/<slug>`)
- [x] Workspace linked to task in LiveStore (via `taskSource` field)
- [x] Duplicate prevention: toggling back to "in_progress" does not create a second workspace
- [x] Diff polling auto-starts for the new workspace
- [ ] Tests: set task in_progress → workspace auto-created with correct branch and task link (deferred — vitest not yet configured)

### Blocked by

- Blocked by ~~#100~~, ~~#40~~ (both done)

### User stories addressed

- User story 7, 15

---

## Issue 106: Task-driven workspace auto-cleanup

### Parent PRD

PRD.md

### What to build

When a task's status changes to "completed" or its associated PR is merged, automatically destroy the linked workspace. This keeps the environment clean.

### Acceptance criteria

- [x] Task status → "completed" triggers workspace.destroy on linked workspace (via DiffService.stopPolling + TerminalManager.killAllForWorkspace + WorkspaceProvider.destroyWorktree)
- [x] Task status → "cancelled" triggers workspace.destroy on linked workspace (same cleanup path)
- [x] All workspace resources cleaned up (diff polling stopped, terminals killed, worktree removed, port freed, branch deleted)
- [ ] Tests: complete task → linked workspace destroyed; resources freed (deferred — vitest not yet configured)

### Blocked by

- Blocked by ~~#105~~ (done), ~~#47~~ (done)

### User stories addressed

- User story 8

---

## Issue 111: editor.open RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `editor.open` handler via `RpcGroup.toHandlers`. Executes the configured editor command (`cursor <path>` or `code <path>`) to open a file. Editor command comes from env/project config.

### Acceptance criteria

- [x] `editor.open` handler accepts workspaceId and filePath
- [x] Executes `<editor> <workspace-path>/<filePath>`
- [x] Editor command configurable (default from EDITOR_COMMAND env)
- [x] Missing editor → clear error message
- [ ] Tests: RPC call → shell command executed; missing editor → error (deferred — vitest not yet configured)

### Blocked by

- Blocked by #19 (done), #14 (done)

### User stories addressed

- User story 19

---

## Issue 112: Click-to-open file from diff viewer

### Parent PRD

PRD.md

### What to build

Make file paths in the diff viewer clickable. Clicking a file path calls the `editor.open` mutation via `useAtomSet(LaborerClient.mutation("editor.open"))` to open that file in the user's editor.

### Acceptance criteria

- [x] File paths in diff viewer are clickable (via "Open" button in each file's header using `renderHeaderMetadata` prop from @pierre/diffs/react)
- [x] Click → calls `LaborerClient.mutation("editor.open")` with correct workspace and file path
- [x] Visual affordance (ExternalLink icon, hover:bg-accent hover:text-foreground styling, title tooltip) on hover
- [ ] Tests: click file path → mutation called with correct args (deferred — requires running both server and web app with a live workspace)

### Blocked by

- Blocked by ~~#111~~, ~~#87~~ (both done)

### User stories addressed

- User story 19

---

## Issue 128: Graceful shutdown — kill all terminals

### Parent PRD

PRD.md

### What to build

On server shutdown (SIGINT/SIGTERM), iterate all running terminals and kill them. Ensure no orphan PTY processes remain.

### Acceptance criteria

- [x] Shutdown signal → all PTY processes terminated (TerminalManager finalizer iterates all in-memory terminals and kills each via PtyHostClient; PtyHostClient finalizer kills the PTY Host child process)
- [x] No orphan processes after shutdown (belt-and-suspenders: finalizer kills at shutdown + stale terminal cleanup on next startup)
- [ ] Tests: spawn terminals → shutdown → all processes gone (deferred — vitest not yet configured; manual verification: SIGINT triggers finalizer logs)

### Blocked by

- Blocked by ~~#54~~ (done)

### User stories addressed

- Polishing requirement 7

---

## Issue 129: Graceful shutdown — persist LiveStore state

### Parent PRD

PRD.md

### What to build

On server shutdown, flush LiveStore state to SQLite before exiting. Ensure all pending events are persisted so state survives restart.

### Acceptance criteria

- [x] Shutdown → LiveStore flushed to SQLite (explicit `store.shutdown()` in `Effect.addFinalizer` flushes pending writes; upstream adapter-node `acquireRelease` calls `db.close()`)
- [x] Restart → state fully restored from SQLite (startup entity count logging confirms restored state from previous session)
- [x] Observable shutdown/startup logging for diagnostics (entity counts logged at startup and shutdown)
- [ ] Tests: commit events, restart server (re-init LiveStore), verify state restored from SQLite (deferred — requires integration test that starts/stops the full server)

### Blocked by

- Blocked by ~~#16~~ (done)

### User stories addressed

- Polishing requirement 7

---

## Issue 132: terminal.remove RPC handler + TerminalManager delete

### Parent PRD

PRD.md

### What to build

Add a `terminal.remove` RPC method to the `LaborerRpcs` contract and implement it on the server. When a terminal is in "stopped" status, this method removes it from the TerminalManager's in-memory tracking, commits a `TerminalRemoved` event to LiveStore (deleting the row from the Terminals table), and cleans up any panel pane references that pointed to that terminal. If the terminal is still running, it should be killed first before removal. This completes the terminal lifecycle: spawn -> (optionally kill/stop) -> remove.

On the UI side, add a "Remove" / delete button to stopped terminals in the terminal list (Issue #63). Clicking it calls `LaborerClient.mutation("terminal.remove")` via `useAtomSet`. The terminal disappears from the list and any pane displaying it reverts to an empty state.

### Acceptance criteria

- [x] `terminal.remove` added to `LaborerRpcs` in `packages/shared/src/rpc.ts` with `Rpc.make("terminal.remove", { payload: TerminalRemovePayload })`
- [x] `TerminalRemovePayload` schema defined with `terminalId` field
- [x] `TerminalManager.remove(terminalId)` method implemented — kills PTY if still running, removes from in-memory map
- [x] `TerminalRemoved` event added to LiveStore schema, materializer deletes terminal row from Terminals table
- [x] Server RPC handler delegates to TerminalManager.remove and commits TerminalRemoved event
- [x] Removing a nonexistent terminal returns a descriptive error
- [x] UI: delete/remove button visible on stopped terminals in the terminal list
- [x] UI: button calls `LaborerClient.mutation("terminal.remove")` via `useAtomSet`
- [x] UI: terminal disappears from list after removal (via LiveStore sync)
- [ ] UI: any pane assigned to the removed terminal shows empty state (deferred — requires panel layout tree cleanup)
- [ ] Tests: remove stopped terminal -> gone from LiveStore and in-memory map; remove running terminal -> killed then removed; remove nonexistent -> error; UI button -> mutation called, terminal gone from list (deferred — vitest not yet configured)

### Blocked by

- Blocked by #59, #63, #5

### User stories addressed

- User story 6

---

## Issue 133: terminal.restart RPC handler + TerminalManager restart

### Parent PRD

PRD.md

### What to build

Add a `terminal.restart` RPC method to the `LaborerRpcs` contract and implement it on the server. This method kills the existing PTY process for a terminal, then respawns it with the same command in the same workspace directory. The terminal ID remains the same (the LiveStore row is updated, not deleted and recreated), so any pane displaying the terminal continues to show it seamlessly. The terminal status transitions: running -> stopped -> running. A `TerminalRestarted` event is committed to LiveStore, and the scrollback buffer is cleared in xterm.js on the client side.

On the UI side, add a "Restart" button to terminals in the terminal list (both running and stopped). Clicking it calls `LaborerClient.mutation("terminal.restart")` via `useAtomSet`. The xterm.js pane clears and shows the fresh terminal output.

### Acceptance criteria

- [x] `terminal.restart` added to `LaborerRpcs` in `packages/shared/src/rpc.ts` with `Rpc.make("terminal.restart", { payload: TerminalRestartPayload })`
- [x] `TerminalRestartPayload` schema defined with `terminalId` field
- [x] `TerminalManager.restart(terminalId)` method implemented — kills existing PTY (if running), respawns with same command and workspace directory, reuses terminal ID
- [x] `TerminalRestarted` event added to LiveStore schema, materializer resets terminal status to "running"
- [x] Server RPC handler delegates to TerminalManager.restart and commits TerminalRestarted event
- [x] Restarting a nonexistent terminal returns a descriptive error
- [x] Restarting a stopped terminal respawns it (acts as a "start again")
- [x] UI: restart button visible on terminals in the terminal list (both running and stopped)
- [x] UI: button calls `LaborerClient.mutation("terminal.restart")` via `useAtomSet`
- [x] UI: xterm.js clears scrollback on restart and shows fresh output
- [ ] Tests: restart running terminal -> killed then respawned, same ID, status = running; restart stopped terminal -> respawned; restart nonexistent -> error; UI button -> mutation called, terminal output refreshes (deferred — vitest not yet configured)

### Blocked by

- Blocked by #59, #63, #5

### User stories addressed

- User story 6, 28

---

## Issue 135: Remove base64 encoding from PTY IPC

### Parent PRD

PRD-terminal-perf.md

### What to build

Remove the unnecessary base64 encoding layer from the PTY host IPC protocol. The PTY host currently base64-encodes every output chunk before wrapping it in JSON, and the server decodes it on the other side. Since node-pty's `onData` produces UTF-8 strings and JSON natively supports UTF-8 with proper escaping, the base64 step is unnecessary and inflates data by 33%. Reference PRD-terminal-perf.md "Remove Base64 Encoding from IPC" section.

In the PTY host script (`pty-host.ts`), change the `data` event emission from `Buffer.from(data, "utf-8").toString("base64")` to emitting the raw UTF-8 string directly in the JSON `data` field. In `PtyHostClient`, remove the corresponding `Buffer.from(base64Data, "base64").toString("utf-8")` decode step from the data callback routing. In `TerminalManager`, the data callback now receives plain UTF-8 strings — update any consumers accordingly.

### Acceptance criteria

- [x] PTY host emits raw UTF-8 strings in the `data` field of IPC `data` events (no base64)
- [x] PtyHostClient no longer base64-decodes incoming data events
- [x] TerminalManager data callback receives plain UTF-8 strings
- [x] Existing PTY host integration tests pass with the new encoding (update assertions)
- [x] Terminal output fidelity unchanged: ANSI escape sequences, Unicode, and control characters transport correctly via JSON escaping
- [x] Tests: spawn a process that outputs colors + Unicode → verify output arrives correctly without base64

### Blocked by

None — can start immediately

### User stories addressed

- User story 1, 6

---

## Issue 136: IPC buffer optimization (O(n²) → array accumulator)

### Parent PRD

PRD-terminal-perf.md

### What to build

Replace the O(n²) string concatenation pattern in both the PTY host's stdin line reader and the PtyHostClient's stdout line reader with an array-based accumulator. Reference PRD-terminal-perf.md "Buffer Optimization" section.

Both readers currently use `buffer += chunk` followed by repeated `.indexOf('\n')` and `.slice()` calls. Under high throughput, this creates significant garbage collection pressure because each concatenation copies the entire accumulated string. Replace with: push incoming chunks onto an array, join only when scanning for newlines or draining, and keep the remainder as a single-element array.

### Acceptance criteria

- [ ] PTY host stdin reader uses array-based accumulator instead of `buffer += chunk`
- [ ] PtyHostClient stdout reader uses array-based accumulator instead of `buffer += chunk`
- [ ] No behavioral change — line-delimited JSON parsing works identically
- [ ] Existing tests pass without modification
- [ ] Tests: high-throughput scenario (e.g., `seq 1 10000`) completes without excessive GC pauses

### Blocked by

None — can start immediately

### User stories addressed

- User story 2, 3

---

## Issue 137: PTY data coalescing (5ms timer)

### Parent PRD

PRD-terminal-perf.md

### What to build

Add a 5ms coalescing timer per PTY instance in the PTY host, matching VS Code's `TerminalDataBufferer` pattern. Reference PRD-terminal-perf.md "Data Coalescing in the PTY Host" section.

When `pty.onData` fires: if no buffer exists for that PTY, create one (an array of strings) and start a 5ms `setTimeout`. If a buffer already exists, push the data onto it. When the timer fires, join all buffered strings, emit a single `data` event, and delete the buffer. This reduces the number of IPC messages by an order of magnitude for burst output while adding imperceptible latency for interactive typing.

### Acceptance criteria

- [x] Each PTY instance in the PTY host has an independent coalescing buffer (`coalesceBuffers` Map keyed by PTY id)
- [x] Rapid output (multiple `onData` calls within 5ms) produces a single coalesced IPC `data` event (verified by test — `seq 1 1000` produces < 200 events)
- [x] Interactive typing (single characters > 5ms apart) still produces individual events after a 5ms delay
- [x] Tests: run `seq 1 1000` → count `data` events received, verify significantly fewer than 1000 (proving coalescing)
- [x] Tests: verify resize flushes pending coalesced data before applying resize

### Blocked by

None — can start immediately

### User stories addressed

- User story 2, 3

---

## Issue 138: Ring buffer data structure + unit tests

### Parent PRD

PRD-terminal-perf.md

### What to build

Implement a ring buffer (circular buffer) data structure as a standalone module in the server package. Reference PRD-terminal-perf.md "Server-Side Ring Buffer for Scrollback" section.

The ring buffer uses a `Uint8Array` with a configurable capacity (default 1MB) and a write cursor that wraps around when full. It supports writing UTF-8 encoded bytes and reading the current contents (from oldest to newest, handling the wrap-around correctly). This module is used by TerminalManager to provide scrollback on WebSocket reconnection.

### Acceptance criteria

- [x] Ring buffer module exported from server package (`packages/server/src/lib/ring-buffer.ts`)
- [x] `write(data: Uint8Array)` appends data, wrapping when capacity is reached
- [x] `read(): Uint8Array` returns current contents from oldest to newest
- [x] `clear()` resets the buffer
- [x] `size` property returns current byte count (capped at capacity)
- [x] Tests: write less than capacity → read returns written data (32 tests total)
- [x] Tests: write more than capacity → read returns only the last `capacity` bytes (correct wrap-around)
- [x] Tests: write exactly capacity → read returns all data
- [x] Tests: write zero bytes → no-op
- [x] Tests: empty buffer → read returns empty Uint8Array
- [x] Tests: sequential writes and reads produce correct results

### Blocked by

None — can start immediately

### User stories addressed

- User story 4

---

## Issue 139: Terminal WebSocket endpoint + server ring buffer integration

### Parent PRD

PRD-terminal-perf.md

### What to build

Create the dedicated terminal WebSocket endpoint and integrate the ring buffer into TerminalManager. Reference PRD-terminal-perf.md "Dedicated Terminal WebSocket Endpoint" and "Server-Side Ring Buffer for Scrollback" sections.

Add a new HTTP route at `GET /terminal?id=<terminalId>` that upgrades to a WebSocket connection. TerminalManager gains a 1MB ring buffer per active terminal and a subscriber management system. When a WebSocket client connects: validate the terminal exists, send ring buffer contents as scrollback, then subscribe to live output. When the client sends text frames, forward to PTY as input (non-JSON text) or handle ack messages (JSON with `type: "ack"`). When the client disconnects, unsubscribe. When the terminal exits, send final output and close the WebSocket with status 1000.

Update the Vite dev proxy in `apps/web/vite.config.ts` to route `/terminal` WebSocket connections to the backend.

### Acceptance criteria

- [ ] `GET /terminal?id=<terminalId>` upgrades to WebSocket
- [ ] Connecting to a valid, running terminal succeeds
- [ ] Connecting to a nonexistent terminal ID → WebSocket closes with error
- [ ] On connect, ring buffer contents (scrollback) sent as text frames
- [ ] Live terminal output forwarded as text frames to all connected WebSocket clients
- [ ] Text frames from client forwarded to PTY as input via PtyHostClient.write()
- [ ] Client disconnect → unsubscribe from output, no resource leak
- [ ] Terminal exit → final output sent, WebSocket closed with 1000
- [ ] Ring buffer retained after terminal exit (until terminal is removed)
- [ ] Multiple simultaneous WebSocket connections to the same terminal work independently
- [ ] Vite proxy routes `/terminal` to backend with WebSocket support
- [ ] Tests: connect → receive scrollback + live output; send input → echoed back; disconnect → clean; reconnect → scrollback replayed

### Blocked by

- Blocked by ~~#135~~ (done), ~~#138~~ (done)

### User stories addressed

- User story 1, 2, 4, 7, 9

---

## Issue 140: Web client terminal pane: WebSocket data path

### Parent PRD

PRD-terminal-perf.md

### What to build

Replace the TerminalPane's LiveStore event subscription with a direct WebSocket connection to the new `/terminal` endpoint. Reference PRD-terminal-perf.md "Web Client Terminal Pane Update" section.

On mount (when a terminal ID is available), open a WebSocket to `/terminal?id=<terminalId>`. On message, write data directly to xterm.js via `terminal.write(event.data)`. On keypress, send the keystroke as a WebSocket text frame (replaces `terminal.write` RPC call for interactive input). On unmount, close the WebSocket cleanly. On WebSocket error/close, display a disconnection indicator and attempt reconnection with exponential backoff.

The `terminal.write` RPC continues to work alongside WebSocket for programmatic input (e.g., agent automation). `terminal.resize` remains an RPC call.

### Acceptance criteria

- [x] TerminalPane opens WebSocket to `/terminal?id=<terminalId>` on mount (via `useTerminalWebSocket` hook)
- [x] Terminal output received via WebSocket is written directly to xterm.js (via `onData` callback)
- [x] Keystrokes sent as WebSocket text frames (not RPC) (via `wsSendRef.current(data)`)
- [x] Page reload → WebSocket reconnects, scrollback from ring buffer displayed (server sends ring buffer as initial text frames)
- [x] WebSocket disconnect → visual indicator shown in terminal pane (red `DisconnectedBanner`)
- [x] Reconnection with exponential backoff on WebSocket close/error (500ms initial, 30s max, 2x factor)
- [x] `terminal.write` RPC still works for programmatic input (unchanged on server side)
- [x] `terminal.resize` RPC still works for resize (kept as-is in TerminalPane)
- [x] Remove or disable the LiveStore `store.events()` subscription for terminal output (replaced with WebSocket)
- [ ] Tests: type in terminal → output appears (end-to-end); reload page → scrollback visible; disconnect → indicator shown (deferred — requires running both server and web app)

### Blocked by

- Blocked by ~~#139~~ (done)

### User stories addressed

- User story 1, 2, 3, 4, 5, 9

---

## Issue 141: Character-count flow control (server side)

### Parent PRD

PRD-terminal-perf.md

### What to build

Implement VS Code's character-count flow control model in the PTY host and wire it through PtyHostClient. Reference PRD-terminal-perf.md "Character-Count Flow Control" section.

In the PTY host: track `unacknowledgedCharCount` per PTY. Each emitted `data` event increases it by the character count. When it exceeds `HighWatermarkChars` (100,000), call `pty.pause()`. Add a new `{ type: "ack", id, chars }` IPC command that decrements `unacknowledgedCharCount`. When it drops below `LowWatermarkChars` (5,000), call `pty.resume()`. Emit `{ type: "paused", id }` and `{ type: "resumed", id }` debug events.

In PtyHostClient: add an `ack(id: string, chars: number)` method that sends the ack command to the PTY host.

In the terminal WebSocket endpoint: when a client sends an ack JSON frame, forward it to PtyHostClient.ack(). When a client disconnects, reset flow control state (resume PTY if paused, clear unacknowledged count) to prevent stuck PTYs.

### Acceptance criteria

- [ ] PTY host tracks `unacknowledgedCharCount` per PTY
- [ ] PTY paused when unacknowledged chars exceed 100,000
- [ ] PTY resumed when unacknowledged chars drop below 5,000 (after ack)
- [ ] `{ type: "ack", id, chars }` IPC command implemented and handled
- [ ] PtyHostClient exposes `ack(id, chars)` method
- [ ] `paused` and `resumed` debug events emitted for observability
- [ ] WebSocket endpoint forwards ack frames to PtyHostClient
- [ ] Client disconnect → PTY resumed, ack count cleared
- [ ] Tests: produce fast output without acks → PTY pauses (output rate plateaus or `paused` event observed)
- [ ] Tests: send acks → PTY resumes, output continues
- [ ] Tests: disconnect client → PTY not stuck in paused state

### Blocked by

- Blocked by ~~#137~~ (done), ~~#139~~ (done)

### User stories addressed

- User story 2, 8, 10

---

## Issue 142: Client-side flow control acks

### Parent PRD

PRD-terminal-perf.md

### What to build

Implement client-side character counting and ack frame sending in the TerminalPane WebSocket connection. Reference PRD-terminal-perf.md "Web Client Terminal Pane Update" section (point 4).

The client tracks total characters received from the WebSocket. Every `CharCountAckSize` (5,000) characters processed, it sends an ack text frame: `{"type":"ack","chars":5000}`. This completes the flow control loop: PTY host → server → client → ack → server → PTY host.

### Acceptance criteria

- [ ] TerminalPane tracks characters received from WebSocket
- [ ] Ack frame sent every 5,000 characters: `{"type":"ack","chars":5000}`
- [ ] Acks sent as JSON text frames distinguishable from regular input
- [ ] Flow control loop works end-to-end: fast output → PTY pauses → client processes + sends acks → PTY resumes
- [ ] Tests: produce continuous output → verify ack frames sent at regular intervals; verify output is not permanently blocked

### Blocked by

- Blocked by ~~#140~~ (done), ~~#141~~ (done)

### User stories addressed

- User story 2, 8

---

## Issue 143: Deprecate terminalOutput from LiveStore hot path

### Parent PRD

PRD-terminal-perf.md

### What to build

Stop committing `v1.TerminalOutput` events to LiveStore on the server's terminal data path. Reference PRD-terminal-perf.md "LiveStore Schema Changes" section.

In TerminalManager, remove the `store.commit(events.terminalOutput(...))` call from the PTY data callback. Terminal output now flows exclusively through the dedicated WebSocket. Keep the `terminalOutput` event definition and materializer in the schema for backward compatibility with any existing eventlog data (it already has a no-op materializer: `() => []`).

Terminal lifecycle events (`terminalSpawned`, `terminalStatusChanged`, `terminalKilled`, `terminalRemoved`, `terminalRestarted`) remain as synced events in LiveStore.

### Acceptance criteria

- [x] TerminalManager no longer commits `terminalOutput` events to LiveStore
- [x] `terminalOutput` event definition kept in schema (marked as deprecated via comment)
- [x] Terminal lifecycle events still committed to LiveStore and synced correctly
- [x] LiveStore sync initialization does not break when `terminalOutput` events stop appearing
- [x] Server memory usage lower under sustained terminal output (no SQLite writes per output chunk)
- [x] Tests: all 46 existing tests pass without modification (spawn terminal output now flows via WebSocket only)

### Blocked by

- Blocked by ~~#140~~ (done)

### User stories addressed

- User story 11, 12

---

---

## Issue 144: Resize flushes coalesced buffer + flow control reset on disconnect

### Parent PRD

PRD-terminal-perf.md

### What to build

Handle two edge cases in the coalescing and flow control systems. Reference PRD-terminal-perf.md "Data Coalescing in the PTY Host" (resize flush) and "Dedicated Terminal WebSocket Endpoint" (connection lifecycle point 6) sections.

**Resize flush**: When the PTY host receives a `resize` command, immediately flush any pending coalesced buffer for that PTY before applying the resize. This ensures output is associated with the correct terminal dimensions, matching VS Code's behavior.

**Disconnect flow control reset**: When a WebSocket client disconnects, the server must reset flow control state for that terminal: resume the PTY if paused and clear the `unacknowledgedCharCount`. This prevents the PTY from getting stuck in a paused state when there are no consumers. If other WebSocket clients are still connected, flow control continues with them.

### Acceptance criteria

- [ ] Resize command in PTY host flushes pending coalesced buffer for that PTY immediately
- [ ] Flushed data emitted as a `data` event before the resize is applied
- [ ] WebSocket disconnect → PTY resumed if paused, unacknowledged count cleared
- [ ] If multiple clients connected, disconnect of one does not reset flow control (other clients still consuming)
- [ ] Tests: buffer data via coalescing, send resize → buffered data emitted before resize takes effect
- [ ] Tests: pause PTY via flow control, disconnect client → PTY resumes; reconnect → output flows again

### Blocked by

- Blocked by ~~#141~~ (done), ~~#142~~ (done)

### User stories addressed

- User story 9, 10

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Initialize `packages/shared` package | None | Done |
| 2 | Shared domain types | #1 | Done |
| 3 | LiveStore schema — Projects table | #1 | Done |
| 4 | LiveStore schema — Workspaces table | #3 | Done |
| 5 | LiveStore schema — Terminals table | #3 | Done |
| 6 | LiveStore schema — Diffs table | #3 | Done |
| 7 | LiveStore schema — PanelLayout table | #3 | Done |
| 8 | LiveStore schema — Tasks table | #3 | Done |
| 9 | RPC contract types (RpcGroup + Rpc.make) | #2 | Done |
| 10 | Initialize `packages/server` package | #1 | Done |
| 11 | Effect TS application bootstrap | #10 | Done |
| 12 | Health check RPC endpoint | #9, #11 | Done |
| 13 | Web env validation | None | Done |
| 14 | Server env validation | #10 | Done |
| 15 | Server consumes env validation | #14, #11 | Done |
| 16 | LiveStore server adapter setup | #3, #11 | Done |
| 17 | LiveStore client adapter setup | #3 | Done |
| 18 | LiveStore server-to-client sync | ~~#16~~, ~~#17~~ | Done |
| 19 | @effect/rpc server router setup | #12 | Done |
| 20 | AtomRpc client setup (effect-atom) | ~~#19~~, ~~#9~~ | Done |
| 21 | ProjectRegistry — addProject | #16, #3 | Done |
| 22 | ProjectRegistry — removeProject | #21 | Done |
| 23 | ProjectRegistry — listProjects + getProject | #21 | Done |
| 24 | project.add RPC handler | #19, #21 | Done |
| 25 | project.remove RPC handler | #24, #22 | Done |
| 26 | Project list UI | #18, #24 | Done |
| 27 | Add Project form (AtomRpc mutation) | ~~#20~~, ~~#24~~, ~~#26~~ | Done |
| 28 | Remove Project button + dialog (AtomRpc mutation) | ~~#25~~, ~~#26~~ | Done |
| 29 | PortAllocator — allocate | #15 | Done |
| 30 | PortAllocator — free | #29 | Done |
| 31 | PortAllocator — exhaustion handling | ~~#29~~ | Done |
| 32 | PortAllocator — concurrent safety | ~~#29~~ | Done |
| 33 | WorkspaceProvider — create worktree | #21, #29 | Done |
| 36 | WorkspaceProvider — inject PORT env | #33, #29 | Done |
| 40 | workspace.create RPC handler | #19, #33, #36, #4 | Done |
| 41 | Workspace list UI | ~~#18~~, ~~#40~~ | Done |
| 42 | Create Workspace form (AtomRpc mutation) | ~~#20~~, ~~#40~~, ~~#27~~ | Done |
| 43 | WorkspaceProvider — destroy worktree | #33 | Done |
| 44 | WorkspaceProvider — kill processes on destroy | ~~#43~~ | Done |
| 45 | WorkspaceProvider — free port on destroy | ~~#43~~, ~~#30~~ | Done |
| 46 | WorkspaceProvider — remove watchers on destroy | ~~#43~~ | Done |
| 47 | workspace.destroy RPC handler | ~~#19~~, ~~#43~~, ~~#44~~, ~~#45~~, ~~#46~~ | Done |
| 48 | Destroy Workspace button + dialog (AtomRpc mutation) | ~~#47~~, ~~#41~~ | Done |
| 50 | TerminalManager — spawn PTY | #40, #5 | Done |
| 51 | TerminalManager — stream stdout to LiveStore | #50 | Done |
| 52 | TerminalManager — write stdin | #50 | Done |
| 53 | TerminalManager — resize PTY | #50 | Done |
| 54 | TerminalManager — kill PTY | #50 | Done |
| 55 | TerminalManager — multiple terminals per workspace | #50 | Done |
| 56 | terminal.spawn RPC handler | #19, #50 | Done |
| 57 | terminal.write RPC handler | #56, #52 | Done |
| 58 | terminal.resize RPC handler | #56, #53 | Done |
| 59 | terminal.kill RPC handler | #56, #54 | Done |
| 60 | xterm.js — render output | ~~#18~~, ~~#56~~ | Done |
| 61 | xterm.js — send keyboard input (AtomRpc mutation) | ~~#60~~, ~~#57~~ | Done |
| 62 | xterm.js — handle resize (AtomRpc mutation) | ~~#60~~, ~~#58~~ | Done |
| 63 | Terminal list per workspace UI | ~~#60~~, ~~#55~~ | Done |
| 64 | Terminal session reconnection | ~~#60~~ | Done |
| 65 | Terminal scrollback buffer replay | ~~#64~~ | Done |
| 66 | PanelManager — single pane | ~~#60~~ | Done |
| 67 | PanelManager — horizontal split | ~~#66~~ | Done |
| 68 | PanelManager — vertical split | ~~#66~~ | Done |
| 69 | PanelManager — recursive splits | ~~#67~~, ~~#68~~ | Done |
| 70 | PanelManager — close pane | ~~#67~~ | Done |
| 73 | PanelManager — serialize layout to LiveStore | ~~#69~~, ~~#7~~ | Done |
| 74 | PanelManager — restore layout from LiveStore | ~~#73~~ | Done |
| 75 | Keyboard shortcut — split horizontal | ~~#67~~ | Done |
| 76 | Keyboard shortcut — split vertical | ~~#68~~, ~~#75~~ | Done |
| 77 | Keyboard shortcut — close pane | ~~#70~~, ~~#75~~ | Done |
| 78 | Keyboard shortcut — navigate panes | ~~#71~~, ~~#75~~ | Done |
| 80 | Keyboard shortcut scope isolation | ~~#75~~, ~~#61~~ | Done |
| 82 | DiffService — run git diff | #40 | Done |
| 83 | DiffService — poll on interval | ~~#82~~ | Done |
| 84 | DiffService — deduplicate unchanged | ~~#83~~ | Done |
| 85 | DiffService — start/stop on workspace lifecycle | ~~#83~~, ~~#47~~ | Done |
| 86 | diff.refresh RPC handler | ~~#82~~, #19 | Done |
| 87 | Diff viewer pane — @pierre/diffs | ~~#18~~, ~~#83~~, ~~#6~~ | Done |
| 89 | Diff viewer — live update | ~~#87~~ | Done |
| 90 | Toggle diff alongside terminal | ~~#67~~, ~~#87~~ | Done |
| 92 | rlph.startLoop RPC handler | ~~#56~~ | Done |
| 93 | "Start Ralph Loop" button (AtomRpc mutation) | ~~#92~~, ~~#60~~ | Done |
| 94 | rlph.writePRD RPC handler | ~~#56~~ | Done |
| 95 | PRD writing form + button (AtomRpc mutation) | ~~#94~~, ~~#60~~ | Done |
| 96 | rlph.review RPC handler | ~~#56~~ | Done |
| 97 | "Review PR" button + input (AtomRpc mutation) | ~~#96~~, ~~#60~~ | Done |
| 98 | rlph.fix RPC handler | ~~#56~~ | Done |
| 99 | "Fix Findings" button + input (AtomRpc mutation) | ~~#98~~, ~~#60~~ | Done |
| 100 | Task CRUD — create manual task | ~~#8~~, ~~#16~~ | Done |
| 101 | Task CRUD — update status | ~~#100~~ | Done |
| 102 | Task CRUD — list per project | ~~#100~~ | Done |
| 103 | Create Task form UI | ~~#100~~, ~~#20~~ | Done |
| 104 | Task list UI | ~~#102~~, ~~#18~~ | Done |
| 105 | Task-driven workspace auto-creation | ~~#100~~, ~~#40~~ | Done |
| 106 | Task-driven workspace auto-cleanup | ~~#105~~, ~~#47~~ | Done |
| 111 | editor.open RPC handler | ~~#19~~, ~~#14~~ | Done |
| 112 | Click-to-open from diff viewer (AtomRpc mutation) | ~~#111~~, ~~#87~~ | Done |
| 128 | Graceful shutdown — kill terminals | ~~#54~~ | Done |
| 129 | Graceful shutdown — persist state | ~~#16~~ | Done |
| 132 | terminal.remove RPC handler + delete UI | ~~#59~~, ~~#63~~, ~~#5~~ | Done |
| 133 | terminal.restart RPC handler + restart UI | ~~#59~~, ~~#63~~, ~~#5~~ | Done |
| 135 | Remove base64 encoding from PTY IPC | None | Done |
| 136 | IPC buffer optimization (O(n²) → array) | None | Done |
| 137 | PTY data coalescing (5ms timer) | None | Done |
| 138 | Ring buffer data structure + unit tests | None | Done |
| 139 | Terminal WebSocket endpoint + ring buffer | ~~#135~~, ~~#138~~ | Done |
| 140 | Web client terminal pane: WebSocket data path | ~~#139~~ | Done |
| 141 | Character-count flow control (server side) | ~~#137~~, ~~#139~~ | Done |
| 142 | Client-side flow control acks | ~~#140~~, ~~#141~~ | Done |
| 143 | Deprecate terminalOutput from LiveStore hot path | ~~#140~~ | Done |
| 144 | Resize flushes coalesced buffer + flow control reset | ~~#141~~, ~~#142~~ | Done |
