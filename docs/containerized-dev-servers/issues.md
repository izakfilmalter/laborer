# Issues: Containerized Dev Servers

## Issue 1: devServer config schema in laborer.json

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Add a `devServer` configuration object to the `laborer.json` schema in `ConfigService`. This is the foundation that all other container issues depend on for knowing which image to use and what command to run.

The `devServer` object has four fields: `image` (base Docker image name), `dockerfile` (path to a Dockerfile), `startCommand` (the command to boot the dev server), and `workdir` (mount point inside the container, defaults to `/app`). The `image` and `dockerfile` fields are mutually exclusive -- validation should reject configs that specify both.

These fields follow the existing layered resolution pattern (project `laborer.json` -> ancestor directories -> global config -> defaults). Each resolved field carries provenance metadata via `ResolvedValue<T>`. The `devServer` section should also be editable via the existing `writeProjectConfig` RPC so the UI settings modal can update it.

See the PRD "Container Configuration in laborer.json" section for the full schema.

### Acceptance criteria

- [x] `LaborerConfig` type in ConfigService gains an optional `devServer` object with `image?: string`, `dockerfile?: string`, `startCommand?: string`, `workdir?: string`
- [x] `ResolvedLaborerConfig` gains corresponding `ResolvedValue<>` fields for each devServer property
- [x] Validation rejects configs where both `image` and `dockerfile` are specified (mutually exclusive)
- [x] Default values: `workdir` defaults to `/app`, others default to `undefined`
- [x] Layered resolution works: project-level `devServer.image` overrides global-level
- [x] `writeProjectConfig` RPC supports updating `devServer` fields
- [x] `ConfigResponse` schema in shared `rpc.ts` includes the new devServer fields
- [x] Unit tests for devServer config parsing, validation, and resolution
- [x] Type checks pass (`bun run check-types`)
- [x] `bun x ultracite check` passes

### Blocked by

None -- can start immediately.

### User stories addressed

- User story 12
- User story 13
- User story 18

---

## Issue 2: Docker prerequisite detection

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Create a `DockerDetection` Effect service that checks whether Docker (via OrbStack) is available on the system. This runs on server startup and exposes the result via RPC so the web UI can show an error banner when Docker is missing.

Detection logic: (1) check if `docker` CLI exists on PATH via `which docker`, (2) check if Docker daemon is running via `docker info`. Expose a `docker.status` RPC that returns `{ available: boolean, error?: string }`.

On the web UI side, if `docker.status` returns `available: false`, show a persistent warning banner at the top of the app with the error message and a link to install OrbStack.

### Acceptance criteria

- [x] New `DockerDetection` Effect service in `packages/server/src/services/`
- [x] Service checks `docker` CLI availability and daemon status
- [x] Service runs on server startup and caches the result
- [x] New `docker.status` RPC exposed in `LaborerRpcs`
- [x] RPC returns `{ available: boolean, error?: string }`
- [x] Web UI queries `docker.status` on mount
- [x] Warning banner displayed when Docker is unavailable with actionable message
- [x] Banner includes link to OrbStack download page
- [x] Type checks pass
- [x] `bun x ultracite check` passes

### Blocked by

None -- can start immediately.

### User stories addressed

- User story 16

---

## Issue 3: Container naming/sanitization

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Create a pure utility function in `packages/shared` that converts a `(branchName, projectName)` pair into a DNS-safe Docker container name and its corresponding `.orb.local` URL.

The function must: (1) replace slashes with hyphens, (2) lowercase everything, (3) strip invalid characters (only `[a-z0-9-]` allowed), (4) collapse consecutive hyphens, (5) trim leading/trailing hyphens, (6) truncate to 63 characters (DNS label limit per RFC 1035) with a 6-character SHA-256 hash suffix for uniqueness when truncation occurs, (7) produce the container name as `{branchSlug}--{projectSlug}` and URL as `{containerName}.orb.local`.

This is a pure function with no side effects -- ideal for comprehensive unit testing.

### Acceptance criteria

- [x] Pure function `containerName(branchName: string, projectName: string): { name: string, url: string }` exported from `packages/shared`
- [x] Slashes converted to hyphens (`feature/auth` -> `feature-auth`)
- [x] All characters lowercased
- [x] Invalid characters stripped (only `[a-z0-9-]` retained)
- [x] Consecutive hyphens collapsed
- [x] Leading/trailing hyphens trimmed
- [x] Names exceeding 63 chars truncated with 6-char hash suffix
- [x] Output format: `{branchSlug}--{projectSlug}`
- [x] URL format: `{containerName}.orb.local`
- [x] Unit tests cover: simple names, slashes, long names, special characters, unicode, empty segments, names exactly at 63 chars
- [x] Type checks pass
- [x] `bun x ultracite check` passes

### Blocked by

None -- can start immediately.

### User stories addressed

- User story 20

---

## Issue 4: LiveStore schema for container state

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Extend the `workspaces` LiveStore table to track container state. Add three new nullable columns: `containerId` (Docker container ID), `containerUrl` (the `.orb.local` URL), and `containerImage` (the Docker image used).

Add two new events: `ContainerStarted` (sets containerId, containerUrl, containerImage on a workspace) and `ContainerStopped` (clears containerId). Both events use the existing `Schema.optionalWith` pattern for backward-compatible additions.

Write materializers for these events that update the workspace row.

### Acceptance criteria

- [x] `workspaces` table gains `containerId: text({ nullable: true })`, `containerUrl: text({ nullable: true })`, `containerImage: text({ nullable: true })` columns
- [x] `ContainerStarted` event defined with `workspaceId`, `containerId`, `containerUrl`, `containerImage` fields
- [x] `ContainerStopped` event defined with `workspaceId` field
- [x] Materializers: `ContainerStarted` updates workspace row with container fields; `ContainerStopped` sets `containerId` to null
- [x] Backward compatible: existing workspaces without containers continue to work (null defaults)
- [x] Events use `Events.synced` pattern
- [x] Type checks pass
- [x] `bun x ultracite check` passes

### Blocked by

None -- can start immediately.

### User stories addressed

- Foundational infrastructure for Issues 5-11

---

## Issue 5: ContainerService -- create and destroy

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Create a `ContainerService` Effect service that manages Docker container lifecycle. This is the core backend tracer bullet -- the first time a container actually runs as part of workspace creation.

On workspace create (when `devServer` config exists): after the git worktree is created, run `docker run -d --name {containerName} -v {worktreePath}:{workdir} -w {workdir} {image} sleep infinity` to start a long-running container with the worktree bind-mounted. Store the container ID and `.orb.local` URL in LiveStore via `ContainerStarted` event.

On workspace destroy: run `docker stop {containerName} && docker rm {containerName}` before the existing worktree cleanup. Emit `ContainerStopped` event. Follow the existing best-effort cleanup pattern (log warnings on individual failures, don't abort remaining steps).

Integrate into the existing `WorkspaceProvider.createWorktree` and `destroyWorktree` pipelines -- container creation happens after worktree creation; container destruction happens before worktree removal.

### Acceptance criteria

- [x] New `ContainerService` Effect service in `packages/server/src/services/`
- [x] `createContainer(workspaceId, worktreePath, branchName, projectName, devServerConfig)` method
- [x] Runs `docker run -d --name {containerName} -v {worktreePath}:{workdir} -w {workdir} {image} sleep infinity`
- [x] Container name generated using the naming utility from Issue 3
- [x] `ContainerStarted` event committed to LiveStore with containerId, containerUrl, containerImage
- [x] `destroyContainer(workspaceId)` method runs `docker stop` then `docker rm`
- [x] `ContainerStopped` event committed to LiveStore
- [x] Destroy follows best-effort cleanup pattern (catches errors, logs warnings, continues)
- [x] Integrated into `WorkspaceProvider.createWorktree` pipeline (container created after worktree, only when devServer config is present)
- [x] Integrated into `WorkspaceProvider.destroyWorktree` pipeline (container destroyed before worktree removal)
- [x] Rollback: if container creation fails, workspace creation fails with clear error
- [x] Type checks pass
- [x] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 1 (devServer config schema)
- Blocked by Issue 3 (container naming)
- Blocked by Issue 4 (LiveStore schema)

### User stories addressed

- User story 1
- User story 3
- User story 15
- User story 17

---

## Issue 6: Dev server terminal -- docker exec shell

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Extend `TerminalClient.spawnInWorkspace` to detect containerized workspaces and spawn a terminal session inside the container via `docker exec` instead of a host PTY.

When a terminal spawn is requested for a workspace that has a `containerId` in LiveStore, the `TerminalClient` should construct the command as `docker exec -it {containerName} /bin/sh` (or `/bin/bash` if the image supports it). The `cwd` for the PTY process on the host is irrelevant since the shell runs inside the container at the configured `workdir`.

The terminal service's PTY host spawns `docker exec` as a local process -- the PTY wraps the docker exec command, so terminal I/O (including resize, signals) flows through naturally. No changes needed to the terminal service itself -- only `TerminalClient.spawnInWorkspace` needs the container-aware spawn logic.

### Acceptance criteria

- [x] `TerminalClient.spawnInWorkspace` checks for `containerId` on the workspace LiveStore record
- [x] When `containerId` is present, constructs spawn command as `docker exec -it {containerName} /bin/sh`
- [x] The `SpawnPayload.command` is set to `docker`, `args` to `['exec', '-it', containerName, '/bin/sh']`
- [x] Terminal I/O works correctly (typing, output, Ctrl+C, resize)
- [x] Shell session runs inside the container at the configured workdir
- [x] Non-containerized workspaces continue to spawn host PTY (no regression)
- [x] Type checks pass
- [x] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 5 (ContainerService must exist to have a running container)

### User stories addressed

- User story 7
- User story 14

---

## Issue 7: Auto-run setup scripts + start command in container terminal

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

After spawning the container terminal (Issue 6), automatically execute setup scripts and then the dev server start command by writing them into the terminal.

When a dev server terminal is spawned for a containerized workspace: (1) read `setupScripts` from resolved laborer.json config, (2) for each script, write it into the terminal via `TerminalManager.write()` followed by a newline, (3) after all setup scripts, write the `devServer.startCommand` followed by a newline.

The scripts are "auto-typed" into the terminal -- the user sees them appear and execute in real-time. This means the user can see setup output (e.g., `bun install` progress) and dev server boot logs in the same terminal session.

For v1, there is no explicit "wait for completion" between scripts -- they are written sequentially with a small delay. The terminal is interactive, so if a setup script fails, the user can see the error and re-run manually.

### Acceptance criteria

- [x] After container terminal spawn, setup scripts from `laborer.json` are auto-typed into the terminal
- [x] Each script is written via `TerminalManager.write()` with a trailing newline
- [x] After all setup scripts, `devServer.startCommand` is written with a trailing newline
- [x] Small delay between script writes to allow shell to process each line
- [x] If no setup scripts configured, only the start command is written
- [x] If no start command configured, only setup scripts run (or nothing if both are empty)
- [x] User can see all script output in the terminal pane
- [x] User can interact with the terminal after auto-typing completes (Ctrl+C, re-run, etc.)
- [x] Type checks pass
- [x] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 1 (devServer config for startCommand)
- Blocked by Issue 6 (container terminal must exist)

### User stories addressed

- User story 6
- User story 13

---

## Issue 8: Dev server terminal pane type + toggle

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Add a `devServerTerminal` pane type to the panel system and make it toggleable, matching the existing diff viewer toggle pattern.

In `PaneType` schema (shared types), add `'devServerTerminal'` as a new literal. In `PaneContent` (web app), handle this new type by rendering a `TerminalPane` with a distinct visual indicator (colored left border or header icon) to distinguish it from agent terminals.

Add a toggle button in the workspace area (alongside the existing diff toggle) that shows/hides the dev server terminal pane. When a workspace is created with a container, the dev server terminal pane auto-opens.

The pane should use the same `LeafNode` structure as regular terminals but with `paneType: 'devServerTerminal'`. The toggle behavior follows the `diffOpen` pattern -- a boolean on the node or a panel action that adds/removes the pane.

### Acceptance criteria

- [x] `PaneType` schema in shared types includes `'devServerTerminal'`
- [x] `PaneContent` component handles `devServerTerminal` pane type
- [x] Dev server terminal pane has a visual distinction from agent terminals (colored border, icon, or label)
- [x] Toggle button added to workspace controls for showing/hiding the dev server pane
- [x] Toggle follows the same interaction pattern as the diff viewer toggle
- [x] When workspace with container is created, dev server pane auto-opens
- [x] Pane can be closed and reopened via the toggle
- [x] Terminal reconnection works when toggling (scrollback preserved)
- [x] Type checks pass
- [x] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 6 (docker exec terminal must work)

### User stories addressed

- User story 8
- User story 9

---

## Issue 9: Workspace URL display -- replace port with .orb.local link

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Replace the port number display in the workspace sidebar card with a clickable `.orb.local` URL for containerized workspaces.

Currently the workspace card shows `:<port>` in the `CardDescription`. For workspaces with a `containerUrl` in LiveStore, replace this with the full `.orb.local` URL as a clickable link that opens in the default browser. Add a copy-to-clipboard button on hover, using the same `CopyableValue` component pattern used for the worktree name.

Non-containerized workspaces continue to show the port number (backward compatible).

### Acceptance criteria

- [ ] Workspace card reads `containerUrl` from the workspace LiveStore record
- [ ] When `containerUrl` is present, displays it as a clickable link instead of `:<port>`
- [ ] Link opens the URL in the default browser on click
- [ ] Copy button appears on hover, copies the full URL to clipboard
- [ ] Uses the existing `CopyableValue` component pattern for consistency
- [ ] Non-containerized workspaces still show `:<port>` (no regression)
- [ ] Link text is styled with monospace font matching the existing port display
- [ ] HTTPS URL variant (`https://...orb.local`) is accessible (OrbStack provides this automatically)
- [ ] Type checks pass
- [ ] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 5 (containerUrl must be stored in LiveStore)

### User stories addressed

- User story 2
- User story 4
- User story 5
- User story 19

---

## Issue 10: Container pause/unpause RPCs

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Add `container.pause` and `container.unpause` RPCs to the `ContainerService`. These call `docker pause` and `docker unpause` on the workspace's container and update state in LiveStore.

`docker pause` freezes all processes in the container (using cgroups freezer). `docker unpause` thaws them. This is instant and preserves all running state -- the dev server resumes exactly where it left off.

Add a `containerStatus` field to the LiveStore workspace record (or use the existing `status` field) to track `'running'` vs `'paused'` container states.

### Acceptance criteria

- [ ] `ContainerService.pauseContainer(workspaceId)` method calls `docker pause {containerName}`
- [ ] `ContainerService.unpauseContainer(workspaceId)` method calls `docker unpause {containerName}`
- [ ] `container.pause` RPC exposed in `LaborerRpcs`
- [ ] `container.unpause` RPC exposed in `LaborerRpcs`
- [ ] Container state updated in LiveStore after pause/unpause
- [ ] Error handling: pausing an already-paused container returns gracefully (idempotent)
- [ ] Error handling: unpausing a non-paused container returns gracefully (idempotent)
- [ ] Error handling: operating on a non-existent container returns a clear error
- [ ] Type checks pass
- [ ] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 5 (ContainerService must exist with a running container)

### User stories addressed

- User story 10
- User story 11

---

## Issue 11: Wire pause/unpause to workspace play/pause buttons

### Parent PRD

PRD-containerized-dev-servers.md

### What to build

Connect the existing play/pause buttons in the workspace sidebar to the `container.pause`/`container.unpause` RPCs for containerized workspaces.

Currently the play button triggers `rlph.startLoop`. For containerized workspaces, the play/pause buttons should instead call the container pause/unpause RPCs. The workspace status badge should reflect the container state: running = green, paused = yellow/amber.

When paused, the dev server terminal pane freezes (docker exec session is frozen). When unpaused, it resumes. This happens automatically because the terminal is running inside the container.

### Acceptance criteria

- [ ] Play button calls `container.unpause` RPC for containerized workspaces
- [ ] Pause button calls `container.pause` RPC for containerized workspaces
- [ ] Non-containerized workspaces retain existing play button behavior (no regression)
- [ ] Status badge shows paused state distinctly (yellow/amber color with "paused" label)
- [ ] Button icon changes between play/pause based on container state
- [ ] Loading state shown during pause/unpause RPC calls
- [ ] Error toast shown if pause/unpause fails
- [ ] Terminal pane freezes when paused, resumes when unpaused (inherent Docker behavior, just verify)
- [ ] Type checks pass
- [ ] `bun x ultracite check` passes

### Blocked by

- Blocked by Issue 9 (workspace URL display, ensures sidebar is container-aware)
- Blocked by Issue 10 (pause/unpause RPCs must exist)

### User stories addressed

- User story 10
- User story 11
