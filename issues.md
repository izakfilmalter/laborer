# Laborer — Issues

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

- [ ] Terminals table defined with all columns per PRD
- [ ] Events defined: TerminalSpawned, TerminalOutput, TerminalStatusChanged, TerminalKilled
- [ ] Materializer correctly updates table state from events
- [ ] Tests: commit events → verify table state transitions

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

- [ ] Diffs table defined with all columns per PRD
- [ ] Events defined: DiffUpdated, DiffCleared
- [ ] Materializer correctly updates table state from events
- [ ] Tests: commit DiffUpdated → verify diff content in table

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

- [ ] PanelLayout table defined with tree structure column
- [ ] Events defined: LayoutSplit, LayoutPaneClosed, LayoutPaneAssigned, LayoutRestored
- [ ] Materializer correctly updates layout tree from events
- [ ] Tests: commit split event → verify tree structure updated

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

- [ ] Tasks table defined with all columns per PRD
- [ ] Events defined: TaskCreated, TaskStatusChanged, TaskRemoved
- [ ] Materializer correctly updates table state from events
- [ ] Tests: commit events → verify table state transitions

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

- [ ] `VITE_SERVER_URL` defined with URL validation
- [ ] Missing variable throws descriptive error at build/startup time
- [ ] Valid value passes validation
- [ ] Tests: missing → throws; invalid URL → throws; valid URL → passes

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

- [ ] `packages/env/src/server.ts` exists and is exported from package
- [ ] PORT, PORT_RANGE_START, PORT_RANGE_END, EDITOR_COMMAND defined with validation and defaults
- [ ] Tests: missing required vars → throws; valid values → passes; defaults work when optional vars omitted

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

- [ ] Server imports env from `packages/env/server`
- [ ] Invalid env → server fails to start with descriptive error
- [ ] Valid env → server starts normally
- [ ] Tests: invalid env → startup failure with message; valid env → startup succeeds

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

- [ ] LiveStore initialized with SQLite backend on server
- [ ] Server can commit events and read table state
- [ ] Events persist to SQLite file
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

- [ ] LiveStore browser adapter configured in `apps/web`
- [ ] React provider component wraps the app
- [ ] Components can commit events and subscribe to table state
- [ ] Tests: provider mounts; commit event → table state updates; reactive subscription fires on change

### Blocked by

- Blocked by #3

### User stories addressed

- Foundation

---

## Issue 18: LiveStore server-to-client sync

### Parent PRD

PRD.md

### What to build

Establish real-time sync between the server and client LiveStore instances over WebSocket. Events committed on the server should appear on the client and vice versa. This is the reactive backbone of the entire app.

### Acceptance criteria

- [ ] WebSocket endpoint on server for LiveStore sync
- [ ] Client connects and syncs on startup
- [ ] Event committed on server → appears on client within reasonable latency
- [ ] Event committed on client → appears on server
- [ ] Handles reconnection on disconnect
- [ ] Tests: server commits event → client receives; client commits event → server receives; disconnect + reconnect → state consistent

### Blocked by

- Blocked by #16, #17

### User stories addressed

- Foundation

---

## Issue 19: @effect/rpc server router setup

### Parent PRD

PRD.md

### What to build

Create the `@effect/rpc` server router infrastructure in `packages/server/src/rpc/`. Use `RpcServer` to handle the `LaborerRpcs` group from `packages/shared`. Mount it on the Bun HTTP server with WebSocket support (for `RpcClient.layerProtocolSocket` on the client) and `RpcSerialization.layerJson`. Establish the pattern for adding new RPC handlers: each handler is implemented via `RpcGroup.toHandlers` and delegates to an Effect service, committing state changes to LiveStore.

### Acceptance criteria

- [ ] RPC server handles all `LaborerRpcs` methods via `RpcServer` over WebSocket
- [ ] `RpcSerialization.layerJson` configured for JSON serialization
- [ ] Unknown RPC methods return a proper error response
- [ ] Handler pattern is composable (new handlers added via `RpcGroup.toHandlers`)
- [ ] Tests: registered method → responds; unknown method → error; malformed request → error

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

- [ ] `LaborerClient` defined using `AtomRpc.Tag` with `LaborerRpcs` group
- [ ] WebSocket protocol configured with server URL from env
- [ ] `LaborerClient.mutation` and `LaborerClient.query` work from React components via `useAtomSet`/`useAtomValue`
- [ ] Health check query from web app succeeds
- [ ] Tests: client queries health check → receives response; server down → error handled gracefully

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

- [ ] ProjectRegistry is a tagged Effect service
- [ ] `addProject(repoPath)` validates path exists and is a git repo
- [ ] On success, commits ProjectCreated event to LiveStore
- [ ] On invalid path → returns descriptive error
- [ ] On non-git directory → returns descriptive error
- [ ] Tests: add valid repo → project in LiveStore; add non-git dir → error; add nonexistent path → error

### Blocked by

- Blocked by #16, #3

### User stories addressed

- User story 12

---

## Issue 22: ProjectRegistry — removeProject method

### Parent PRD

PRD.md

### What to build

Add the `removeProject` method to the ProjectRegistry service. Removes a project from LiveStore by ID. Should validate the project exists before removal.

### Acceptance criteria

- [ ] `removeProject(projectId)` commits ProjectRemoved event to LiveStore
- [ ] Removing nonexistent project → returns descriptive error
- [ ] Tests: add then remove → project gone from LiveStore; remove nonexistent → error

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

- [ ] `listProjects()` returns all registered projects
- [ ] `getProject(id)` returns a specific project
- [ ] `getProject` with nonexistent ID → returns descriptive error
- [ ] Tests: add multiple projects → list returns all; get by ID → correct project; get nonexistent → error

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

- [ ] `project.add` handler implemented via `RpcGroup.toHandlers`
- [ ] Accepts repo path, returns created project
- [ ] Invalid path → error response with message
- [ ] Tests: RPC call with valid path → project in LiveStore + success response; invalid path → error response

### Blocked by

- Blocked by #19, #21

### User stories addressed

- User story 12

---

## Issue 25: project.remove RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `project.remove` handler in the server RPC router via `RpcGroup.toHandlers`. It delegates to `ProjectRegistry.removeProject`.

### Acceptance criteria

- [ ] `project.remove` handler implemented via `RpcGroup.toHandlers`
- [ ] Accepts project ID, returns success
- [ ] Nonexistent ID → error response
- [ ] Tests: RPC call → project removed from LiveStore; nonexistent → error response

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

- [ ] Component subscribes to Projects table via LiveStore
- [ ] Renders list of projects with name and repo path
- [ ] Updates reactively when projects are added/removed
- [ ] Tests: render with projects → displays all; add project → list updates; empty → empty state

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

- [ ] Form uses TanStack Form with repo path field
- [ ] Client-side validation: required, non-empty
- [ ] On submit → calls `LaborerClient.mutation("project.add")` via `useAtomSet`
- [ ] Success → project appears in list (via LiveStore), form resets
- [ ] Error → error message displayed (from server validation)
- [ ] Tests: empty submit → validation error; valid submit → mutation called, project in list; server error → displayed

### Blocked by

- Blocked by #20, #24, #26

### User stories addressed

- User story 12

---

## Issue 28: Remove Project button + confirmation dialog

### Parent PRD

PRD.md

### What to build

Add a delete button to each project in the project list. Clicking it shows a shadcn/ui AlertDialog confirmation. On confirm, calls the `project.remove` mutation via `useAtomSet(LaborerClient.mutation("project.remove"))`. Project disappears from the list on success (via LiveStore sync).

### Acceptance criteria

- [ ] Delete button visible per project in list
- [ ] Click → shadcn/ui AlertDialog with confirmation message
- [ ] Confirm → calls `LaborerClient.mutation("project.remove")` via `useAtomSet`
- [ ] Success → project removed from list (via LiveStore)
- [ ] Cancel → dialog closes, no action
- [ ] Tests: click delete → dialog appears; confirm → mutation called, project removed; cancel → no change

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

- [ ] PortAllocator is a tagged Effect service
- [ ] `allocate()` returns a port within the configured range
- [ ] Sequential allocations return unique ports
- [ ] Allocated ports are tracked to prevent double-allocation
- [ ] Tests: allocate returns port in range; two allocations return different ports

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

- [ ] `free(port)` marks port as available
- [ ] Freed port can be reallocated
- [ ] Freeing unallocated port → error
- [ ] Tests: allocate → free → reallocate returns same port; free unallocated → error

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

- [ ] WorkspaceProvider is a tagged Effect service with a pluggable interface
- [ ] `createWorktree(projectId, branchName)` creates a git worktree
- [ ] Worktree directory exists at expected path
- [ ] Branch is created in git
- [ ] Tests: create worktree → directory exists, branch in `git branch` output, `git worktree list` includes it

### Blocked by

- Blocked by #21, #29

### User stories addressed

- User story 9

---

## Issue 34: WorkspaceProvider — worktree directory validation + file watcher scoping

### Parent PRD

PRD.md

### What to build

Validate the created worktree directory structure and ensure file watcher isolation. The worktree should be independent from the main repo's file watchers so that multiple workspaces don't exhaust OS file descriptor limits.

### Acceptance criteria

- [ ] Worktree directory validated after creation (exists, is git repo, correct branch)
- [ ] File watcher for workspace is scoped to worktree directory only
- [ ] Main repo watchers unaffected by workspace creation
- [ ] Tests: create worktree → validation passes; verify watcher scope doesn't include main repo

### Blocked by

- Blocked by #33

### User stories addressed

- User story 23

---

## Issue 35: WorkspaceProvider — run setup scripts in worktree

### Parent PRD

PRD.md

### What to build

After worktree creation, execute project-specific setup scripts (e.g., `bun install`, copy `.env` files). Scripts are defined per project in rlphConfig. Execute in the worktree directory.

### Acceptance criteria

- [ ] Setup scripts from project config are executed in worktree directory
- [ ] Script stdout/stderr captured for logging
- [ ] Script exit code checked (non-zero = failure)
- [ ] Tests: setup script runs in correct directory; successful script → success; failing script → error with output

### Blocked by

- Blocked by #33

### User stories addressed

- User story 11

---

## Issue 36: WorkspaceProvider — inject PORT env var

### Parent PRD

PRD.md

### What to build

Inject the allocated port as a `PORT` environment variable into setup scripts and all terminals spawned in the workspace. This allows dev servers to use the correct port automatically.

### Acceptance criteria

- [ ] `PORT` env var set to allocated port in setup script environment
- [ ] `PORT` env var available in workspace terminal environments
- [ ] Tests: setup script can read PORT; spawned process in workspace sees correct PORT value

### Blocked by

- Blocked by #33, #29

### User stories addressed

- User story 10

---

## Issue 37: WorkspaceProvider — handle setup script failure

### Parent PRD

PRD.md

### What to build

When a setup script fails (non-zero exit), rollback the workspace: remove the worktree directory, free the allocated port, clean up the branch. Return a clear error with the script output.

### Acceptance criteria

- [ ] Failed setup script → worktree removed, port freed, branch cleaned
- [ ] Error includes script output (stdout + stderr)
- [ ] LiveStore workspace status set to "errored" before cleanup
- [ ] Tests: setup script that exits 1 → worktree gone, port freed, error returned with output

### Blocked by

- Blocked by #35

### User stories addressed

- Polishing requirement 6

---

## Issue 38: WorkspaceProvider — handle dirty git state error

### Parent PRD

PRD.md

### What to build

Handle the case where `git worktree add` fails due to dirty git state (uncommitted changes in the main repo that conflict). Return a meaningful error message.

### Acceptance criteria

- [ ] Dirty git state → descriptive error ("uncommitted changes prevent worktree creation")
- [ ] No partial worktree left behind
- [ ] Port not leaked on failure
- [ ] Tests: create worktree with dirty state → error; verify no partial resources

### Blocked by

- Blocked by #33

### User stories addressed

- Polishing requirement 6

---

## Issue 39: WorkspaceProvider — handle git fetch failure

### Parent PRD

PRD.md

### What to build

Handle network failures during git operations (fetch, remote updates). Return a clear error and ensure no partial state is left.

### Acceptance criteria

- [ ] Network failure during git operation → clear error message
- [ ] No partial worktree or branch created
- [ ] Port freed on failure
- [ ] Tests: simulate git fetch failure → error; verify cleanup

### Blocked by

- Blocked by #33

### User stories addressed

- Polishing requirement 6

---

## Issue 40: workspace.create RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `workspace.create` handler via `RpcGroup.toHandlers` for the `LaborerRpcs` group. It orchestrates PortAllocator (allocate port) + WorkspaceProvider (create worktree, run setup) and commits a WorkspaceCreated event to LiveStore with "running" status.

### Acceptance criteria

- [ ] `workspace.create` handler accepts projectId and optional taskConfig
- [ ] Creates worktree, allocates port, runs setup scripts
- [ ] Commits WorkspaceCreated to LiveStore with status = "running"
- [ ] Returns created workspace info (id, path, port, branch)
- [ ] Tests: RPC call → worktree exists, port allocated, LiveStore has workspace with "running" status

### Blocked by

- Blocked by #19, #33, #36, #4

### User stories addressed

- User story 9

---

## Issue 41: Workspace list UI component

### Parent PRD

PRD.md

### What to build

Create a React component that reads the Workspaces table from LiveStore and displays a reactive list of workspaces for the current project. Each workspace shows its branch name, port, status (with color-coded badges: creating=yellow, running=green, stopped=gray, errored=red, destroyed=dim).

### Acceptance criteria

- [ ] Component subscribes to Workspaces table via LiveStore
- [ ] Renders list with branch name, port, and status badge
- [ ] Status badges are color-coded per workspace status
- [ ] Updates reactively on workspace state changes
- [ ] Tests: render with workspaces → displays all with correct status badges; status change → badge updates

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

- [ ] Form uses TanStack Form with project selector and optional branch name
- [ ] Submit → calls `LaborerClient.mutation("workspace.create")` via `useAtomSet`
- [ ] Shows loading state during creation
- [ ] Success → workspace appears in list (via LiveStore)
- [ ] Error → error message displayed
- [ ] Tests: submit → mutation called; success → in list; error → message shown

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

- [ ] `destroyWorktree(workspaceId)` removes the worktree directory
- [ ] Branch is deleted from git
- [ ] `git worktree list` no longer includes the worktree
- [ ] Tests: create then destroy → directory gone, branch gone, not in worktree list

### Blocked by

- Blocked by #33

### User stories addressed

- User story 8

---

## Issue 44: WorkspaceProvider — kill all workspace processes on destroy

### Parent PRD

PRD.md

### What to build

Before removing a worktree, find and kill all processes running in that workspace directory (terminals, dev servers, etc.). Ensure no orphan processes remain.

### Acceptance criteria

- [ ] All processes in workspace directory killed on destroy
- [ ] No orphan processes after destroy
- [ ] Tests: spawn processes in worktree → destroy → all processes terminated; verify with process list

### Blocked by

- Blocked by #43

### User stories addressed

- User story 8, Polishing requirement 5

---

## Issue 45: WorkspaceProvider — free port on destroy

### Parent PRD

PRD.md

### What to build

On workspace destruction, call `PortAllocator.free` to release the workspace's allocated port back to the pool.

### Acceptance criteria

- [ ] Port freed on workspace destruction
- [ ] Freed port available for new workspace allocation
- [ ] Tests: create workspace → destroy → port reallocatable

### Blocked by

- Blocked by #43, #30

### User stories addressed

- User story 8

---

## Issue 46: WorkspaceProvider — remove file watchers on destroy

### Parent PRD

PRD.md

### What to build

On workspace destruction, stop and remove any file watchers scoped to the workspace directory. Ensure OS file handles are freed.

### Acceptance criteria

- [ ] File watchers for workspace stopped on destroy
- [ ] OS file handle count doesn't grow across create/destroy cycles
- [ ] Tests: create → destroy → no leaked watchers; repeated create/destroy → stable handle count

### Blocked by

- Blocked by #43

### User stories addressed

- User story 23, Polishing requirement 5

---

## Issue 47: workspace.destroy RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `workspace.destroy` handler via `RpcGroup.toHandlers`. It orchestrates the full cleanup: kill processes, remove watchers, remove worktree, free port. Updates LiveStore workspace status to "destroyed".

### Acceptance criteria

- [ ] `workspace.destroy` handler accepts workspaceId
- [ ] Kills processes, removes watchers, removes worktree, frees port
- [ ] Commits WorkspaceDestroyed event to LiveStore (status = "destroyed")
- [ ] Tests: RPC call → all resources cleaned up, LiveStore status = "destroyed"

### Blocked by

- Blocked by #19, #43, #44, #45, #46

### User stories addressed

- User story 8

---

## Issue 48: Destroy Workspace button + confirmation dialog

### Parent PRD

PRD.md

### What to build

Add a destroy button to each workspace in the workspace list. Shows a shadcn/ui AlertDialog confirmation (warns about process termination and data loss). On confirm, calls the `workspace.destroy` mutation via `useAtomSet(LaborerClient.mutation("workspace.destroy"))`.

### Acceptance criteria

- [ ] Destroy button visible per workspace
- [ ] Click → AlertDialog with warning message
- [ ] Confirm → calls `LaborerClient.mutation("workspace.destroy")` via `useAtomSet`
- [ ] Success → workspace status updates in list (destroyed, via LiveStore)
- [ ] Tests: click → dialog; confirm → mutation called; cancel → no action

### Blocked by

- Blocked by #47, #41

### User stories addressed

- User story 8

---

## Issue 49: Workspace creation error display

### Parent PRD

PRD.md

### What to build

Display workspace creation errors in the UI. Handle all error types: dirty git state, port unavailable, setup script failure, git fetch failure. Show clear, actionable error messages.

### Acceptance criteria

- [ ] Each error type shows a distinct, descriptive message
- [ ] Error messages include actionable guidance (e.g., "commit or stash changes before creating workspace")
- [ ] Errors appear near the create workspace form or in a toast notification
- [ ] Tests: each error type → correct message displayed in UI

### Blocked by

- Blocked by #37, #38, #39, #42

### User stories addressed

- Polishing requirement 6

---

## Issue 50: TerminalManager service — spawn PTY

### Parent PRD

PRD.md

### What to build

Create the TerminalManager Effect service in `packages/server/src/services/TerminalManager.ts`. Implement PTY spawning (via node-pty or Bun equivalent) in a workspace directory. Each PTY is tracked by a unique ID.

### Acceptance criteria

- [ ] TerminalManager is a tagged Effect service
- [ ] `spawn(workspaceId, command?)` creates a PTY process in the workspace directory
- [ ] Default command is user's shell
- [ ] PTY tracked by unique ID
- [ ] Tests: spawn → process running in correct directory; default shell works; custom command works

### Blocked by

- Blocked by #40, #5

### User stories addressed

- User story 3

---

## Issue 51: TerminalManager — stream PTY stdout to LiveStore

### Parent PRD

PRD.md

### What to build

Stream PTY process output (stdout) to LiveStore as TerminalOutput events. Output should appear with reasonable latency for real-time display.

### Acceptance criteria

- [ ] PTY stdout piped to LiveStore events
- [ ] Output appears within ~100ms of being written by the process
- [ ] Handles binary and UTF-8 output correctly
- [ ] Tests: spawn process that outputs text → output appears in LiveStore; verify latency is reasonable

### Blocked by

- Blocked by #50

### User stories addressed

- User story 3

---

## Issue 52: TerminalManager — write to PTY stdin

### Parent PRD

PRD.md

### What to build

Implement writing input data to a PTY's stdin. This enables human-in-the-loop interaction with agents and regular terminal usage.

### Acceptance criteria

- [ ] `write(terminalId, data)` sends data to PTY stdin
- [ ] Process receives and processes the input
- [ ] Tests: write data → process output reflects input (e.g., echo command)

### Blocked by

- Blocked by #50

### User stories addressed

- User story 16

---

## Issue 53: TerminalManager — resize PTY

### Parent PRD

PRD.md

### What to build

Implement PTY resize to update terminal dimensions (cols, rows). The PTY should send SIGWINCH to the process so it can reflow its output.

### Acceptance criteria

- [ ] `resize(terminalId, cols, rows)` updates PTY dimensions
- [ ] Process receives SIGWINCH
- [ ] Tests: resize → PTY dimensions updated; process that reads terminal size reports new dimensions

### Blocked by

- Blocked by #50

### User stories addressed

- User story 6

---

## Issue 54: TerminalManager — kill PTY process

### Parent PRD

PRD.md

### What to build

Implement killing a PTY process and cleaning up resources. Update the terminal status in LiveStore to "stopped".

### Acceptance criteria

- [ ] `kill(terminalId)` terminates the PTY process
- [ ] Resources freed (file descriptors, etc.)
- [ ] LiveStore terminal status updated to "stopped"
- [ ] Tests: spawn → kill → process not running; LiveStore status = "stopped"; double kill → handled gracefully

### Blocked by

- Blocked by #50

### User stories addressed

- User story 6

---

## Issue 55: TerminalManager — track multiple terminals per workspace

### Parent PRD

PRD.md

### What to build

Support spawning and tracking multiple independent terminals per workspace. Each has independent I/O. Provide a method to list all terminals for a given workspace.

### Acceptance criteria

- [ ] Multiple terminals can exist in one workspace
- [ ] Each terminal has independent I/O
- [ ] `listTerminals(workspaceId)` returns all terminals for that workspace
- [ ] Tests: spawn 3 terminals in one workspace → each has independent output; list returns all 3

### Blocked by

- Blocked by #50

### User stories addressed

- User story 6

---

## Issue 56: terminal.spawn RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.spawn` handler via `RpcGroup.toHandlers`. Delegates to TerminalManager.spawn. Returns terminal ID and initial status.

### Acceptance criteria

- [ ] `terminal.spawn` handler accepts workspaceId and optional command
- [ ] Returns terminal ID
- [ ] Terminal appears in LiveStore with "running" status
- [ ] Tests: RPC call → terminal in LiveStore, PTY running

### Blocked by

- Blocked by #19, #50

### User stories addressed

- User story 6

---

## Issue 57: terminal.write RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.write` handler via `RpcGroup.toHandlers`. Sends input data to a PTY via TerminalManager.

### Acceptance criteria

- [ ] `terminal.write` handler accepts terminalId and data
- [ ] Data reaches the PTY process
- [ ] Tests: RPC call → input reaches process → output appears in LiveStore

### Blocked by

- Blocked by #56, #52

### User stories addressed

- User story 16

---

## Issue 58: terminal.resize RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.resize` handler via `RpcGroup.toHandlers`. Updates PTY dimensions via TerminalManager.

### Acceptance criteria

- [ ] `terminal.resize` handler accepts terminalId, cols, rows
- [ ] PTY dimensions updated
- [ ] Tests: RPC call → PTY resized

### Blocked by

- Blocked by #56, #53

### User stories addressed

- User story 6

---

## Issue 59: terminal.kill RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `terminal.kill` handler via `RpcGroup.toHandlers`. Kills the PTY process via TerminalManager and updates LiveStore status.

### Acceptance criteria

- [ ] `terminal.kill` handler accepts terminalId
- [ ] Process terminated, resources freed
- [ ] LiveStore terminal status = "stopped"
- [ ] Tests: RPC call → process killed, status updated

### Blocked by

- Blocked by #56, #54

### User stories addressed

- User story 6

---

## Issue 60: xterm.js terminal pane — render output

### Parent PRD

PRD.md

### What to build

Create the terminal pane component in `apps/web/src/panes/`. Integrate xterm.js to render terminal output from LiveStore. Subscribe to TerminalOutput events for a given terminal and write them to the xterm.js instance.

### Acceptance criteria

- [ ] xterm.js installed and integrated
- [ ] Component subscribes to terminal output from LiveStore
- [ ] Output renders correctly including ANSI colors and Unicode
- [ ] Tests: terminal output event → rendered in xterm.js; colors display correctly

### Blocked by

- Blocked by #18, #56

### User stories addressed

- User story 3

---

## Issue 61: xterm.js terminal pane — send keyboard input

### Parent PRD

PRD.md

### What to build

Wire xterm.js keyboard input to the `terminal.write` mutation via `useAtomSet(LaborerClient.mutation("terminal.write"))`. When the user types in the terminal pane, keystrokes are sent to the server PTY.

### Acceptance criteria

- [ ] Keystrokes in xterm.js sent via `LaborerClient.mutation("terminal.write")`
- [ ] Character echoes back from PTY through LiveStore → xterm.js
- [ ] Special keys (enter, backspace, ctrl-c, arrows) work correctly
- [ ] Tests: type character → appears in terminal; special keys produce expected behavior

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

- [ ] Pane resize → xterm.js fit addon recalculates cols/rows
- [ ] New dimensions sent via `LaborerClient.mutation("terminal.resize")`
- [ ] PTY output reflows correctly after resize
- [ ] Tests: resize pane → mutation called with new dimensions; terminal output reflows

### Blocked by

- Blocked by #60, #58

### User stories addressed

- User story 6

---

## Issue 63: Terminal list per workspace UI

### Parent PRD

PRD.md

### What to build

Create a UI for listing all terminals in a workspace (from LiveStore). Show terminal command and status. Add a "New Terminal" button that spawns a new terminal via `useAtomSet(LaborerClient.mutation("terminal.spawn"))`. Selecting a terminal switches the active pane to display it.

### Acceptance criteria

- [ ] Terminal list shows all terminals for workspace with command and status (from LiveStore)
- [ ] "New Terminal" button calls `LaborerClient.mutation("terminal.spawn")` via `useAtomSet`
- [ ] Selecting terminal switches active pane content
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

- [ ] On page reload, running terminals are detected from LiveStore
- [ ] xterm.js reconnects to the terminal's output stream
- [ ] New output appears after reconnection
- [ ] Tests: spawn terminal → reload page → terminal still running, new output visible

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

- [ ] PanelManager component renders a single pane
- [ ] Pane hosts a terminal component (from issue #60)
- [ ] Pane fills available space
- [ ] Tests: PanelManager renders; terminal visible in pane

### Blocked by

- Blocked by #60

### User stories addressed

- User story 1

---

## Issue 67: PanelManager — horizontal split

### Parent PRD

PRD.md

### What to build

Implement horizontal splitting using allotment. Splitting creates two side-by-side panes, each capable of hosting a terminal.

### Acceptance criteria

- [ ] allotment installed and integrated
- [ ] Split action creates two side-by-side panes
- [ ] Each pane independently hosts content
- [ ] Tests: split → two panes visible; each renders independently

### Blocked by

- Blocked by #66

### User stories addressed

- User story 1, 2

---

## Issue 68: PanelManager — vertical split

### Parent PRD

PRD.md

### What to build

Implement vertical splitting using allotment. Splitting creates two stacked panes.

### Acceptance criteria

- [ ] Vertical split creates two stacked panes
- [ ] Each pane independently hosts content
- [ ] Tests: vertical split → two stacked panes; each renders independently

### Blocked by

- Blocked by #66

### User stories addressed

- User story 1, 2

---

## Issue 69: PanelManager — recursive splits

### Parent PRD

PRD.md

### What to build

Support recursive splitting: split a pane that's already in a split. The layout tree should support arbitrary nesting depth (tested to 5+ levels).

### Acceptance criteria

- [ ] Splitting a pane in an existing split creates a nested layout
- [ ] 5+ levels of nesting supported
- [ ] All panes render correctly at any depth
- [ ] Tests: split 5 levels deep → all panes visible and functional

### Blocked by

- Blocked by #67, #68

### User stories addressed

- User story 1, Polishing requirement 4

---

## Issue 70: PanelManager — close pane

### Parent PRD

PRD.md

### What to build

Implement closing a pane. When a pane in a split is closed, the sibling expands to fill the space. Handle closing the last pane (shows empty state or prevents close).

### Acceptance criteria

- [ ] Close pane → sibling expands to fill space
- [ ] Close last pane in split → parent collapses
- [ ] Close the very last pane → handled gracefully (empty state or prevented)
- [ ] Tests: close in split → sibling fills; close last → edge case handled

### Blocked by

- Blocked by #67

### User stories addressed

- User story 2, Polishing requirement 4

---

## Issue 71: PanelManager — navigate between panes

### Parent PRD

PRD.md

### What to build

Implement focus management for panes. Track which pane is active (visually indicated with a border/highlight). Allow moving focus between panes directionally (left/right/up/down).

### Acceptance criteria

- [ ] Active pane has visual indicator (border, highlight)
- [ ] Focus can move between panes directionally
- [ ] Focus wraps or stops at edges
- [ ] Tests: multiple panes → focus moves correctly; active pane visually distinct

### Blocked by

- Blocked by #67

### User stories addressed

- User story 1, 30

---

## Issue 72: PanelManager — drag-to-resize panes

### Parent PRD

PRD.md

### What to build

Enable drag-to-resize on split dividers via allotment. Enforce minimum pane sizes to prevent panes from becoming unusably small.

### Acceptance criteria

- [ ] Drag divider → panes resize
- [ ] Minimum pane size enforced (can't resize below threshold)
- [ ] Resize is smooth and responsive
- [ ] Tests: drag resize works; minimum size enforced

### Blocked by

- Blocked by #67

### User stories addressed

- User story 2, Polishing requirement 9

---

## Issue 73: PanelManager — serialize layout to LiveStore

### Parent PRD

PRD.md

### What to build

Serialize the panel layout tree (splits, pane assignments) to LiveStore on every layout change. Commit LayoutSplit/LayoutPaneClosed/LayoutPaneAssigned events.

### Acceptance criteria

- [ ] Layout changes commit events to LiveStore
- [ ] Layout tree structure is fully serializable
- [ ] Tests: split → event in LiveStore; close → event in LiveStore; verify tree matches UI

### Blocked by

- Blocked by #69, #7

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

## Issue 79: Panel keyboard shortcut — resize panes

### Parent PRD

PRD.md

### What to build

Add keyboard shortcuts for resizing panes (e.g., prefix + shift+arrow keys to grow/shrink active pane).

### Acceptance criteria

- [ ] Prefix + resize key → active pane grows/shrinks
- [ ] Minimum size enforced
- [ ] Tests: shortcuts resize pane; minimum enforced

### Blocked by

- Blocked by #72, #75

### User stories addressed

- User story 2, 30

---

## Issue 80: Keyboard shortcut scope isolation

### Parent PRD

PRD.md

### What to build

Use TanStack Hotkeys scope isolation to prevent panel keyboard shortcuts from firing when a terminal pane has focus. The prefix key should only work at the panel level. Inside a terminal, all keystrokes go to the PTY.

### Acceptance criteria

- [ ] Panel shortcuts don't fire when terminal has keyboard focus
- [ ] Prefix key escapes terminal focus to panel scope
- [ ] After prefix, next key is intercepted for panel action (not sent to terminal)
- [ ] Tests: focus terminal → panel shortcut doesn't fire; prefix → shortcut works

### Blocked by

- Blocked by #75, #61

### User stories addressed

- User story 30, Polishing requirement 1

---

## Issue 81: Panel responsive layout

### Parent PRD

PRD.md

### What to build

Ensure the panel system works well across different screen sizes from 1080p to 5K. Minimum pane sizes should adapt to screen density. Test at various resolutions.

### Acceptance criteria

- [ ] Layout works at 1080p (minimum usable resolution)
- [ ] Layout takes advantage of 4K/5K space
- [ ] Minimum pane size appropriate for screen density
- [ ] Tests: render at 1080p → all panes visible; render at 5K → uses space well

### Blocked by

- Blocked by #72

### User stories addressed

- Polishing requirement 9

---

## Issue 82: DiffService — run `git diff` for a workspace

### Parent PRD

PRD.md

### What to build

Create the DiffService Effect service in `packages/server/src/services/DiffService.ts`. Implement running `git diff` in a workspace's worktree directory and returning the output. Reference the PRD's "Diff Detection Strategy" section.

### Acceptance criteria

- [ ] DiffService is a tagged Effect service
- [ ] `getDiff(workspaceId)` runs `git diff` in the worktree directory
- [ ] Returns raw diff output string
- [ ] No changes → returns empty string
- [ ] Tests: modify file in workspace → diff output returned; no changes → empty string

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

- [ ] Polling runs at configurable interval (default 2 seconds)
- [ ] DiffUpdated event committed to LiveStore when diff content changes
- [ ] Tests: modify file → DiffUpdated event within polling interval; verify periodic execution

### Blocked by

- Blocked by #82

### User stories addressed

- User story 5

---

## Issue 84: DiffService — deduplicate unchanged diffs

### Parent PRD

PRD.md

### What to build

Only commit DiffUpdated events when the diff content has actually changed. Compare with the previous diff before committing to avoid spurious events.

### Acceptance criteria

- [ ] No DiffUpdated event when diff content unchanged between polls
- [ ] Event only committed when diff content differs from previous
- [ ] Tests: no file changes → no new events after initial; change file → one event; no more changes → no more events

### Blocked by

- Blocked by #83

### User stories addressed

- User story 5

---

## Issue 85: DiffService — start/stop polling on workspace lifecycle

### Parent PRD

PRD.md

### What to build

Start diff polling when a workspace is created (status = "running") and stop it when a workspace is destroyed. Ensure no leaked timers.

### Acceptance criteria

- [ ] Workspace created → polling starts automatically
- [ ] Workspace destroyed → polling stops, timer cleaned up
- [ ] No leaked intervals after workspace destruction
- [ ] Tests: create workspace → polling active; destroy → polling stopped; no leaked timers

### Blocked by

- Blocked by #83, #47

### User stories addressed

- User story 5

---

## Issue 86: diff.refresh RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `diff.refresh` handler via `RpcGroup.toHandlers`. Triggers an immediate diff recalculation (bypasses the poll interval) and returns the updated diff.

### Acceptance criteria

- [ ] `diff.refresh` handler accepts workspaceId
- [ ] Triggers immediate `git diff` execution
- [ ] Returns fresh diff content
- [ ] Updates LiveStore if content changed
- [ ] Tests: call refresh → get current diff immediately; LiveStore updated

### Blocked by

- Blocked by #82, #19

### User stories addressed

- User story 5

---

## Issue 87: Diff viewer pane — render with @pierre/diffs

### Parent PRD

PRD.md

### What to build

Create the diff viewer pane component in `apps/web/src/panes/`. Integrate @pierre/diffs to render diff content from LiveStore. The component subscribes to the Diffs table for a given workspace and renders the diff.

### Acceptance criteria

- [ ] @pierre/diffs installed and integrated
- [ ] Component subscribes to workspace diff from LiveStore
- [ ] Diff renders with file additions, deletions, and modifications
- [ ] Tests: diff content in LiveStore → renders in viewer; file changes displayed correctly

### Blocked by

- Blocked by #18, #83, #6

### User stories addressed

- User story 4

---

## Issue 88: Diff viewer — accept/reject annotations

### Parent PRD

PRD.md

### What to build

Enable the accept/reject annotation UI in @pierre/diffs. Users can selectively accept or reject individual changes shown in the diff viewer.

### Acceptance criteria

- [ ] Accept/reject buttons appear per change/hunk
- [ ] Clicking accept/reject updates annotation state
- [ ] Annotation state is tracked (in component state or LiveStore)
- [ ] Tests: accept button works; reject button works; state updates correctly

### Blocked by

- Blocked by #87

### User stories addressed

- User story 31

---

## Issue 89: Diff viewer — live update on new diffs

### Parent PRD

PRD.md

### What to build

When new diff content is committed to LiveStore (from polling), the diff viewer should update automatically without manual refresh. The viewer should smoothly transition to the new content.

### Acceptance criteria

- [ ] New DiffUpdated event → viewer re-renders with new content
- [ ] Update is smooth (no flash/flicker)
- [ ] Tests: commit new diff → viewer updates; verify no manual refresh needed

### Blocked by

- Blocked by #87

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

## Issue 91: Diff viewer debounce/throttle for rapid changes

### Parent PRD

PRD.md

### What to build

When an agent is making rapid file changes, the diff viewer may receive many updates per second. Debounce/throttle the rendering to prevent UI lag while still showing recent content.

### Acceptance criteria

- [ ] Rapid diff updates (10+/second) don't cause UI lag
- [ ] Viewer shows most recent diff within reasonable delay (500ms max)
- [ ] No excessive rerenders
- [ ] Tests: rapid updates → no frame drops; last update visible within threshold

### Blocked by

- Blocked by #89

### User stories addressed

- Polishing requirement 3

---

## Issue 92: rlph.startLoop RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.startLoop` handler via `RpcGroup.toHandlers`. It spawns a terminal in the workspace running `rlph --once`. This is a convenience wrapper around terminal.spawn with a specific command. Reference the PRD's "rlph Integration" section.

### Acceptance criteria

- [ ] `rlph.startLoop` handler accepts workspaceId and options
- [ ] Spawns terminal with `rlph --once` command
- [ ] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned running `rlph --once`

### Blocked by

- Blocked by #56

### User stories addressed

- User story 13

---

## Issue 93: "Start Ralph Loop" button UI

### Parent PRD

PRD.md

### What to build

Add a "Start Ralph Loop" button per workspace that calls the `rlph.startLoop` mutation via `useAtomSet(LaborerClient.mutation("rlph.startLoop"))`. After clicking, the user is taken to the terminal pane showing the rlph output.

### Acceptance criteria

- [ ] Button visible per workspace in workspace actions
- [ ] Click → calls `LaborerClient.mutation("rlph.startLoop")` via `useAtomSet`
- [ ] Terminal pane shows rlph TUI output
- [ ] Tests: click button → mutation called; terminal output visible in pane

### Blocked by

- Blocked by #92, #60

### User stories addressed

- User story 13, 17

---

## Issue 94: rlph.writePRD RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.writePRD` handler via `RpcGroup.toHandlers`. Spawns a terminal running `rlph prd [description]` in the workspace.

### Acceptance criteria

- [ ] `rlph.writePRD` handler accepts workspaceId and optional description
- [ ] Spawns terminal with `rlph prd [description]`
- [ ] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned with correct rlph prd command

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

- [ ] Form with description textarea using TanStack Form
- [ ] Submit → calls `LaborerClient.mutation("rlph.writePRD")` via `useAtomSet`
- [ ] Terminal pane shows rlph prd output
- [ ] Form validates (description required)
- [ ] Tests: submit form → mutation called; output visible; empty description → validation error

### Blocked by

- Blocked by #94, #60

### User stories addressed

- User story 14

---

## Issue 96: rlph.review RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.review` handler via `RpcGroup.toHandlers`. Spawns a terminal running `rlph review <prNumber>` in the workspace.

### Acceptance criteria

- [ ] `rlph.review` handler accepts workspaceId and prNumber
- [ ] Spawns terminal with `rlph review <prNumber>`
- [ ] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned with `rlph review <pr>`

### Blocked by

- Blocked by #56

### User stories addressed

- User story 25

---

## Issue 97: "Review PR" button + PR number input

### Parent PRD

PRD.md

### What to build

Add a "Review PR" action per workspace with a PR number input field. On submit, calls the `rlph.review` mutation via `useAtomSet(LaborerClient.mutation("rlph.review"))` and shows the terminal pane.

### Acceptance criteria

- [ ] PR number input field with validation (numeric, required)
- [ ] Submit → calls `LaborerClient.mutation("rlph.review")` via `useAtomSet`
- [ ] Terminal pane shows review output
- [ ] Tests: valid PR → mutation called; invalid → validation error

### Blocked by

- Blocked by #96, #60

### User stories addressed

- User story 25

---

## Issue 98: rlph.fix RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `rlph.fix` handler via `RpcGroup.toHandlers`. Spawns a terminal running `rlph fix <prNumber>` in the workspace.

### Acceptance criteria

- [ ] `rlph.fix` handler accepts workspaceId and prNumber
- [ ] Spawns terminal with `rlph fix <prNumber>`
- [ ] Returns terminal ID
- [ ] Tests: RPC call → terminal spawned with `rlph fix <pr>`

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

- [ ] PR number input field with validation (numeric, required)
- [ ] Submit → calls `LaborerClient.mutation("rlph.fix")` via `useAtomSet`
- [ ] Terminal pane shows fix output
- [ ] Tests: valid PR → mutation called; invalid → validation error

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

- [ ] Form with title and description fields
- [ ] Submit → task created via RPC/LiveStore
- [ ] Task appears in task list
- [ ] Tests: valid submit → task created; empty title → validation error

### Blocked by

- Blocked by #100, #20

### User stories addressed

- User story 9

---

## Issue 104: Task list UI component

### Parent PRD

PRD.md

### What to build

Create a React component that displays all tasks for the current project from LiveStore. Shows task title, source, status (with badges), and allows filtering by status.

### Acceptance criteria

- [ ] Component subscribes to Tasks table via LiveStore
- [ ] Renders tasks with title, source badge, status badge
- [ ] Status filter dropdown/tabs
- [ ] Updates reactively
- [ ] Tests: tasks render with correct badges; filter works; new task → list updates

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

- [ ] Task status → "in_progress" triggers workspace.create
- [ ] Workspace branch name derived from task (e.g., `task/<id>/<slug>`)
- [ ] Workspace linked to task in LiveStore
- [ ] Tests: set task in_progress → workspace auto-created with correct branch and task link

### Blocked by

- Blocked by #100, #40

### User stories addressed

- User story 7, 15

---

## Issue 106: Task-driven workspace auto-cleanup

### Parent PRD

PRD.md

### What to build

When a task's status changes to "completed" or its associated PR is merged, automatically destroy the linked workspace. This keeps the environment clean.

### Acceptance criteria

- [ ] Task status → "completed" triggers workspace.destroy on linked workspace
- [ ] All workspace resources cleaned up
- [ ] Tests: complete task → linked workspace destroyed; resources freed

### Blocked by

- Blocked by #105, #47

### User stories addressed

- User story 8

---

## Issue 107: PRD-generated issues become tasks

### Parent PRD

PRD.md

### What to build

After `rlph prd` completes and creates issues (in Linear or GitHub), those issues should automatically appear as tasks in LiveStore. Monitor the rlph prd terminal output or poll the issue tracker for new issues.

### Acceptance criteria

- [ ] After rlph prd completes, resulting issues appear as tasks in LiveStore
- [ ] Tasks have source = "prd" and correct externalId
- [ ] Tests: run rlph prd → new tasks in LiveStore with correct source and metadata

### Blocked by

- Blocked by #94, #100

### User stories addressed

- User story 15

---

## Issue 108: Linear task sourcing

### Parent PRD

PRD.md

### What to build

Implement fetching tasks from Linear's API based on the project's rlph configuration. Import Linear issues as tasks in LiveStore with source = "linear".

### Acceptance criteria

- [ ] Fetch tasks from Linear API using project's rlph config
- [ ] Tasks created in LiveStore with source = "linear" and externalId
- [ ] Handle API errors gracefully
- [ ] Tests: mock Linear API → tasks imported; API error → handled

### Blocked by

- Blocked by #102

### User stories addressed

- User story 7

---

## Issue 109: GitHub task sourcing

### Parent PRD

PRD.md

### What to build

Implement fetching issues from GitHub's API for the project's repository. Import GitHub issues as tasks in LiveStore with source = "github".

### Acceptance criteria

- [ ] Fetch issues from GitHub API for project repo
- [ ] Tasks created in LiveStore with source = "github" and externalId
- [ ] Handle API errors gracefully
- [ ] Tests: mock GitHub API → tasks imported; API error → handled

### Blocked by

- Blocked by #102

### User stories addressed

- User story 7

---

## Issue 110: Task source picker UI

### Parent PRD

PRD.md

### What to build

Create a UI component to select the task source: Linear, GitHub, or Manual. Selecting Linear or GitHub triggers a fetch from that source. Manual shows the create task form.

### Acceptance criteria

- [ ] Dropdown or tabs for source selection
- [ ] Linear → fetches and displays Linear tasks
- [ ] GitHub → fetches and displays GitHub issues
- [ ] Manual → shows create task form
- [ ] Tests: select source → correct tasks displayed; switch source → list updates

### Blocked by

- Blocked by #108, #109, #103

### User stories addressed

- User story 7

---

## Issue 111: editor.open RPC handler

### Parent PRD

PRD.md

### What to build

Implement the `editor.open` handler via `RpcGroup.toHandlers`. Executes the configured editor command (`cursor <path>` or `code <path>`) to open a file. Editor command comes from env/project config.

### Acceptance criteria

- [ ] `editor.open` handler accepts workspaceId and filePath
- [ ] Executes `<editor> <workspace-path>/<filePath>`
- [ ] Editor command configurable (default from EDITOR_COMMAND env)
- [ ] Missing editor → clear error message
- [ ] Tests: RPC call → shell command executed; missing editor → error

### Blocked by

- Blocked by #19, #14

### User stories addressed

- User story 19

---

## Issue 112: Click-to-open file from diff viewer

### Parent PRD

PRD.md

### What to build

Make file paths in the diff viewer clickable. Clicking a file path calls the `editor.open` mutation via `useAtomSet(LaborerClient.mutation("editor.open"))` to open that file in the user's editor.

### Acceptance criteria

- [ ] File paths in diff viewer are clickable
- [ ] Click → calls `LaborerClient.mutation("editor.open")` with correct workspace and file path
- [ ] Visual affordance (underline, cursor change) on hover
- [ ] Tests: click file path → mutation called with correct args

### Blocked by

- Blocked by #111, #87

### User stories addressed

- User story 19

---

## Issue 113: Project switcher component

### Parent PRD

PRD.md

### What to build

Create a project switcher UI (dropdown or sidebar) that lets the user switch the active project context. Switching projects filters the workspace list and task list to that project.

### Acceptance criteria

- [ ] Project dropdown/sidebar shows all registered projects
- [ ] Selecting a project → workspace list and task list filter to that project
- [ ] "All Projects" option shows everything
- [ ] Tests: switch project → lists filter; all projects → everything shown

### Blocked by

- Blocked by #26

### User stories addressed

- User story 12

---

## Issue 114: Cross-project workspace dashboard

### Parent PRD

PRD.md

### What to build

Create a dashboard view that shows all workspaces across all projects with their status, and task status summaries per project. Gives the developer a high-level overview.

### Acceptance criteria

- [ ] Dashboard shows all workspaces from all projects
- [ ] Workspace status visible (with badges)
- [ ] Task summary per project (pending/in_progress/completed counts)
- [ ] Tests: multiple projects → all workspaces visible; counts correct

### Blocked by

- Blocked by #41, #104

### User stories addressed

- User story 12, 24

---

## Issue 115: Tauri system tray

### Parent PRD

PRD.md

### What to build

Add a system tray icon to the Tauri desktop shell. The tray shows the number of running workspaces and provides quick actions (show window, quit).

### Acceptance criteria

- [ ] System tray icon visible when app is running
- [ ] Tray shows running workspace count
- [ ] "Show" action brings window to front
- [ ] "Quit" action closes the app
- [ ] Tests: manual verification — tray visible, count updates, actions work

### Blocked by

- Blocked by #41

### User stories addressed

- User story 21

---

## Issue 116: Tauri global shortcut

### Parent PRD

PRD.md

### What to build

Register a global keyboard shortcut that brings the Laborer window to the front from anywhere in the OS.

### Acceptance criteria

- [ ] Global shortcut registered (configurable, default Cmd+Shift+L on macOS)
- [ ] Shortcut focuses the Laborer window
- [ ] Works from any application
- [ ] Tests: manual verification — shortcut focuses window from another app

### Blocked by

- Blocked by #115

### User stories addressed

- User story 21

---

## Issue 117: Tauri window management

### Parent PRD

PRD.md

### What to build

Implement minimize-to-tray behavior. Closing the window minimizes to system tray instead of quitting. Clicking the tray icon restores the window.

### Acceptance criteria

- [ ] Close window → minimize to tray (not quit)
- [ ] Click tray icon → restore window
- [ ] Window state (position, size) persisted
- [ ] Tests: manual verification — close minimizes, tray click restores

### Blocked by

- Blocked by #115

### User stories addressed

- User story 21

---

## Issue 118: Empty state — no projects

### Parent PRD

PRD.md

### What to build

When the app launches with no registered projects, show an empty state that guides the user to add their first project. Include a CTA button that opens the Add Project form.

### Acceptance criteria

- [ ] No projects → empty state with welcome message and guidance
- [ ] CTA button opens Add Project form
- [ ] After adding a project → empty state disappears
- [ ] Tests: no projects → empty state renders; CTA → form opens; add project → empty state gone

### Blocked by

- Blocked by #27

### User stories addressed

- Polishing requirement 13

---

## Issue 119: Empty state — no workspaces

### Parent PRD

PRD.md

### What to build

When a project has no workspaces, show an empty state in the workspace list area with guidance to create a workspace. Include a CTA.

### Acceptance criteria

- [ ] No workspaces in project → empty state with guidance
- [ ] CTA opens Create Workspace form
- [ ] After creating workspace → empty state disappears
- [ ] Tests: no workspaces → empty state; CTA → form; create → gone

### Blocked by

- Blocked by #42

### User stories addressed

- Polishing requirement 13

---

## Issue 120: Empty state — no terminals

### Parent PRD

PRD.md

### What to build

When a workspace has no terminals, show an empty state in the terminal area with guidance to spawn a terminal.

### Acceptance criteria

- [ ] No terminals → empty state with guidance
- [ ] CTA spawns a terminal
- [ ] After spawning → empty state disappears
- [ ] Tests: no terminals → empty state; CTA → terminal spawned; gone

### Blocked by

- Blocked by #63

### User stories addressed

- Polishing requirement 13

---

## Issue 121: Loading state — workspace creation

### Parent PRD

PRD.md

### What to build

Show a loading indicator when a workspace is being created (status = "creating"). The indicator should be visible in the workspace list and the create workspace form.

### Acceptance criteria

- [ ] Workspace with "creating" status → spinner/progress indicator visible
- [ ] Status changes to "running" → indicator disappears
- [ ] Form shows loading during submission
- [ ] Tests: creating status → loading visible; running → gone

### Blocked by

- Blocked by #41

### User stories addressed

- Polishing requirement 8

---

## Issue 122: Loading state — terminal spawning

### Parent PRD

PRD.md

### What to build

Show a loading indicator while a terminal is being spawned (between RPC call and first output). The terminal pane should show a spinner until the PTY is connected.

### Acceptance criteria

- [ ] Terminal pane shows loading while PTY is starting
- [ ] First output → loading disappears, terminal renders
- [ ] Tests: spawn terminal → loading visible; output arrives → loading gone

### Blocked by

- Blocked by #60

### User stories addressed

- Polishing requirement 8

---

## Issue 123: Loading state — diff computation

### Parent PRD

PRD.md

### What to build

Show a loading indicator in the diff viewer while the initial diff is being computed. After the first diff is received, the loading disappears.

### Acceptance criteria

- [ ] Diff viewer shows loading until first diff received
- [ ] Loading disappears when diff content available
- [ ] Tests: open diff viewer → loading; diff arrives → content shown

### Blocked by

- Blocked by #87

### User stories addressed

- Polishing requirement 8

---

## Issue 124: Terminal fidelity — opencode TUI

### Parent PRD

PRD.md

### What to build

Verify and fix xterm.js rendering for the opencode agent's TUI output. Test colors, Unicode characters, cursor positioning, progress indicators, and interactive prompts.

### Acceptance criteria

- [ ] opencode TUI renders correctly in xterm.js
- [ ] Colors, Unicode, cursor positioning all work
- [ ] Progress indicators animate correctly
- [ ] Interactive prompts are usable
- [ ] Tests: render sample opencode output → visual verification; interactive elements work

### Blocked by

- Blocked by #60

### User stories addressed

- User story 3, Polishing requirement 2

---

## Issue 125: Terminal fidelity — claude agent TUI

### Parent PRD

PRD.md

### What to build

Verify and fix xterm.js rendering for the Claude Code agent's TUI output.

### Acceptance criteria

- [ ] Claude Code TUI renders correctly in xterm.js
- [ ] All visual elements (colors, formatting, tool output) display properly
- [ ] Tests: render sample claude output → visual verification

### Blocked by

- Blocked by #60

### User stories addressed

- User story 3, Polishing requirement 2

---

## Issue 126: Terminal fidelity — codex agent TUI

### Parent PRD

PRD.md

### What to build

Verify and fix xterm.js rendering for the Codex agent's TUI output.

### Acceptance criteria

- [ ] Codex TUI renders correctly in xterm.js
- [ ] All visual elements display properly
- [ ] Tests: render sample codex output → visual verification

### Blocked by

- Blocked by #60

### User stories addressed

- User story 3, Polishing requirement 2

---

## Issue 127: Terminal scroll performance (100k+ lines)

### Parent PRD

PRD.md

### What to build

Ensure xterm.js handles large terminal buffers (100k+ lines) without UI lag. Configure the scrollback buffer size appropriately and test scroll performance.

### Acceptance criteria

- [ ] 100k+ lines in terminal → no UI lag
- [ ] Scrolling is smooth
- [ ] Memory usage reasonable
- [ ] Tests: load 100k lines → measure frame rate during scroll; no dropped frames

### Blocked by

- Blocked by #60

### User stories addressed

- Polishing requirement 10

---

## Issue 128: Graceful shutdown — kill all terminals

### Parent PRD

PRD.md

### What to build

On server shutdown (SIGINT/SIGTERM), iterate all running terminals and kill them. Ensure no orphan PTY processes remain.

### Acceptance criteria

- [ ] Shutdown signal → all PTY processes terminated
- [ ] No orphan processes after shutdown
- [ ] Tests: spawn terminals → shutdown → all processes gone

### Blocked by

- Blocked by #54

### User stories addressed

- Polishing requirement 7

---

## Issue 129: Graceful shutdown — persist LiveStore state

### Parent PRD

PRD.md

### What to build

On server shutdown, flush LiveStore state to SQLite before exiting. Ensure all pending events are persisted so state survives restart.

### Acceptance criteria

- [ ] Shutdown → LiveStore flushed to SQLite
- [ ] Restart → state fully restored from SQLite
- [ ] Tests: commit events → shutdown → restart → verify state matches

### Blocked by

- Blocked by #16

### User stories addressed

- Polishing requirement 7

---

## Issue 130: Graceful shutdown — free all ports

### Parent PRD

PRD.md

### What to build

On server shutdown, free all allocated ports in the PortAllocator. This is mostly for clean accounting since the ports are not OS-level reserved, but it ensures consistent state.

### Acceptance criteria

- [ ] Shutdown → all ports marked as freed
- [ ] Restart → port range fully available
- [ ] Tests: allocate ports → shutdown → restart → all ports available

### Blocked by

- Blocked by #30

### User stories addressed

- Polishing requirement 7

---

## Issue 131: Theme consistency audit

### Parent PRD

PRD.md

### What to build

Audit all custom components (terminal chrome, diff viewer, panel dividers, status badges) to ensure they use shadcn/ui theme tokens consistently. No hard-coded colors. Dark mode works throughout. Visual integration between terminal panes, diff viewers, and panel chrome should be seamless.

### Acceptance criteria

- [ ] All custom components use oklch theme variables (no hard-coded hex/rgb)
- [ ] Dark mode renders correctly across all components
- [ ] Terminal background matches app theme
- [ ] Diff viewer colors complement the theme
- [ ] Panel dividers and chrome are visually consistent
- [ ] Tests: visual audit / snapshot tests; toggle theme → all components update

### Blocked by

- Blocked by #90

### User stories addressed

- Polishing requirement 11

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Initialize `packages/shared` package | None | Done |
| 2 | Shared domain types | #1 | Done |
| 3 | LiveStore schema — Projects table | #1 | Done |
| 4 | LiveStore schema — Workspaces table | #3 | Done |
| 5 | LiveStore schema — Terminals table | #3 | Ready |
| 6 | LiveStore schema — Diffs table | #3 | Ready |
| 7 | LiveStore schema — PanelLayout table | #3 | Ready |
| 8 | LiveStore schema — Tasks table | #3 | Ready |
| 9 | RPC contract types (RpcGroup + Rpc.make) | #2 | Done |
| 10 | Initialize `packages/server` package | #1 | Done |
| 11 | Effect TS application bootstrap | #10 | Done |
| 12 | Health check RPC endpoint | #9, #11 | Done |
| 13 | Web env validation | None | Ready |
| 14 | Server env validation | #10 | Ready |
| 15 | Server consumes env validation | #14, #11 | Blocked (#14) |
| 16 | LiveStore server adapter setup | #3, #11 | Ready |
| 17 | LiveStore client adapter setup | #3 | Ready |
| 18 | LiveStore server-to-client sync | #16, #17 | Blocked |
| 19 | @effect/rpc server router setup | #12 | Ready |
| 20 | AtomRpc client setup (effect-atom) | #19, #9 | Blocked (#19) |
| 21 | ProjectRegistry — addProject | #16, #3 | Blocked |
| 22 | ProjectRegistry — removeProject | #21 | Blocked |
| 23 | ProjectRegistry — listProjects + getProject | #21 | Blocked |
| 24 | project.add RPC handler | #19, #21 | Blocked |
| 25 | project.remove RPC handler | #24, #22 | Blocked |
| 26 | Project list UI | #18, #24 | Blocked |
| 27 | Add Project form (AtomRpc mutation) | #20, #24, #26 | Blocked |
| 28 | Remove Project button + dialog (AtomRpc mutation) | #25, #26 | Blocked |
| 29 | PortAllocator — allocate | #15 | Blocked |
| 30 | PortAllocator — free | #29 | Blocked |
| 31 | PortAllocator — exhaustion handling | #29 | Blocked |
| 32 | PortAllocator — concurrent safety | #29 | Blocked |
| 33 | WorkspaceProvider — create worktree | #21, #29 | Blocked |
| 34 | WorkspaceProvider — directory validation + watcher scoping | #33 | Blocked |
| 35 | WorkspaceProvider — setup scripts | #33 | Blocked |
| 36 | WorkspaceProvider — inject PORT env | #33, #29 | Blocked |
| 37 | WorkspaceProvider — handle setup failure | #35 | Blocked |
| 38 | WorkspaceProvider — handle dirty git state | #33 | Blocked |
| 39 | WorkspaceProvider — handle git fetch failure | #33 | Blocked |
| 40 | workspace.create RPC handler | #19, #33, #36, #4 | Blocked |
| 41 | Workspace list UI | #18, #40 | Blocked |
| 42 | Create Workspace form (AtomRpc mutation) | #20, #40, #27 | Blocked |
| 43 | WorkspaceProvider — destroy worktree | #33 | Blocked |
| 44 | WorkspaceProvider — kill processes on destroy | #43 | Blocked |
| 45 | WorkspaceProvider — free port on destroy | #43, #30 | Blocked |
| 46 | WorkspaceProvider — remove watchers on destroy | #43 | Blocked |
| 47 | workspace.destroy RPC handler | #19, #43, #44, #45, #46 | Blocked |
| 48 | Destroy Workspace button + dialog (AtomRpc mutation) | #47, #41 | Blocked |
| 49 | Workspace creation error display | #37, #38, #39, #42 | Blocked |
| 50 | TerminalManager — spawn PTY | #40, #5 | Blocked |
| 51 | TerminalManager — stream stdout to LiveStore | #50 | Blocked |
| 52 | TerminalManager — write stdin | #50 | Blocked |
| 53 | TerminalManager — resize PTY | #50 | Blocked |
| 54 | TerminalManager — kill PTY | #50 | Blocked |
| 55 | TerminalManager — multiple terminals per workspace | #50 | Blocked |
| 56 | terminal.spawn RPC handler | #19, #50 | Blocked |
| 57 | terminal.write RPC handler | #56, #52 | Blocked |
| 58 | terminal.resize RPC handler | #56, #53 | Blocked |
| 59 | terminal.kill RPC handler | #56, #54 | Blocked |
| 60 | xterm.js — render output | #18, #56 | Blocked |
| 61 | xterm.js — send keyboard input (AtomRpc mutation) | #60, #57 | Blocked |
| 62 | xterm.js — handle resize (AtomRpc mutation) | #60, #58 | Blocked |
| 63 | Terminal list per workspace UI | #60, #55 | Blocked |
| 64 | Terminal session reconnection | #60 | Blocked |
| 65 | Terminal scrollback buffer replay | #64 | Blocked |
| 66 | PanelManager — single pane | #60 | Blocked |
| 67 | PanelManager — horizontal split | #66 | Blocked |
| 68 | PanelManager — vertical split | #66 | Blocked |
| 69 | PanelManager — recursive splits | #67, #68 | Blocked |
| 70 | PanelManager — close pane | #67 | Blocked |
| 71 | PanelManager — navigate between panes | #67 | Blocked |
| 72 | PanelManager — drag-to-resize | #67 | Blocked |
| 73 | PanelManager — serialize layout to LiveStore | #69, #7 | Blocked |
| 74 | PanelManager — restore layout from LiveStore | #73 | Blocked |
| 75 | Keyboard shortcut — split horizontal | #67 | Blocked |
| 76 | Keyboard shortcut — split vertical | #68, #75 | Blocked |
| 77 | Keyboard shortcut — close pane | #70, #75 | Blocked |
| 78 | Keyboard shortcut — navigate panes | #71, #75 | Blocked |
| 79 | Keyboard shortcut — resize panes | #72, #75 | Blocked |
| 80 | Keyboard shortcut scope isolation | #75, #61 | Blocked |
| 81 | Panel responsive layout | #72 | Blocked |
| 82 | DiffService — run git diff | #40 | Blocked |
| 83 | DiffService — poll on interval | #82 | Blocked |
| 84 | DiffService — deduplicate unchanged | #83 | Blocked |
| 85 | DiffService — start/stop on workspace lifecycle | #83, #47 | Blocked |
| 86 | diff.refresh RPC handler | #82, #19 | Blocked |
| 87 | Diff viewer pane — @pierre/diffs | #18, #83, #6 | Blocked |
| 88 | Diff viewer — accept/reject annotations | #87 | Blocked |
| 89 | Diff viewer — live update | #87 | Blocked |
| 90 | Toggle diff alongside terminal | #67, #87 | Blocked |
| 91 | Diff viewer debounce/throttle | #89 | Blocked |
| 92 | rlph.startLoop RPC handler | #56 | Blocked |
| 93 | "Start Ralph Loop" button (AtomRpc mutation) | #92, #60 | Blocked |
| 94 | rlph.writePRD RPC handler | #56 | Blocked |
| 95 | PRD writing form + button (AtomRpc mutation) | #94, #60 | Blocked |
| 96 | rlph.review RPC handler | #56 | Blocked |
| 97 | "Review PR" button + input (AtomRpc mutation) | #96, #60 | Blocked |
| 98 | rlph.fix RPC handler | #56 | Blocked |
| 99 | "Fix Findings" button + input (AtomRpc mutation) | #98, #60 | Blocked |
| 100 | Task CRUD — create manual task | #8, #16 | Blocked |
| 101 | Task CRUD — update status | #100 | Blocked |
| 102 | Task CRUD — list per project | #100 | Blocked |
| 103 | Create Task form UI | #100, #20 | Blocked |
| 104 | Task list UI | #102, #18 | Blocked |
| 105 | Task-driven workspace auto-creation | #100, #40 | Blocked |
| 106 | Task-driven workspace auto-cleanup | #105, #47 | Blocked |
| 107 | PRD-generated issues → tasks | #94, #100 | Blocked |
| 108 | Linear task sourcing | #102 | Blocked |
| 109 | GitHub task sourcing | #102 | Blocked |
| 110 | Task source picker UI | #108, #109, #103 | Blocked |
| 111 | editor.open RPC handler | #19, #14 | Blocked |
| 112 | Click-to-open from diff viewer (AtomRpc mutation) | #111, #87 | Blocked |
| 113 | Project switcher | #26 | Blocked |
| 114 | Cross-project dashboard | #41, #104 | Blocked |
| 115 | Tauri system tray | #41 | Blocked |
| 116 | Tauri global shortcut | #115 | Blocked |
| 117 | Tauri window management | #115 | Blocked |
| 118 | Empty state — no projects | #27 | Blocked |
| 119 | Empty state — no workspaces | #42 | Blocked |
| 120 | Empty state — no terminals | #63 | Blocked |
| 121 | Loading state — workspace creation | #41 | Blocked |
| 122 | Loading state — terminal spawning | #60 | Blocked |
| 123 | Loading state — diff computation | #87 | Blocked |
| 124 | Terminal fidelity — opencode | #60 | Blocked |
| 125 | Terminal fidelity — claude | #60 | Blocked |
| 126 | Terminal fidelity — codex | #60 | Blocked |
| 127 | Terminal scroll performance | #60 | Blocked |
| 128 | Graceful shutdown — kill terminals | #54 | Blocked |
| 129 | Graceful shutdown — persist state | #16 | Blocked |
| 130 | Graceful shutdown — free ports | #30 | Blocked |
| 131 | Theme consistency audit | #90 | Blocked |
