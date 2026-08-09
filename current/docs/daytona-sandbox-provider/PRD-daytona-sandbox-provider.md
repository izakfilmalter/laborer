## Problem Statement

Laborer's current containerized dev server setup uses Docker via OrbStack to isolate file watchers and dev servers. This works but has significant limitations:

1. **OrbStack/macOS lock-in**: The Docker-based flow depends on OrbStack's `.orb.local` DNS, VirtioFS bind mounts, and macOS-specific behavior. There is no path to running workspaces on other platforms or in the cloud.

2. **Local resource contention**: Running 10-20 concurrent workspaces (each with a dev server, AI coding agent, and file watchers) strains the developer's local machine — CPU, memory, and inotify limits compound as workspace count grows.

3. **No cloud sandbox option**: AI coding agents (Claude Code, Codex, OpenCode) increasingly expect to operate in cloud sandboxes where they have full control of the environment. The current Docker flow ties the agent to the host machine via bind mounts, meaning the agent terminal runs on the host while only the dev server is containerized.

4. **Tight coupling to Docker**: The `ContainerService`, `DepsImageService`, and `WorkspaceProvider` are deeply coupled to Docker CLI commands (`docker run`, `docker pause`, `docker exec`, `docker commit`). Adding a new sandbox provider requires rewriting significant portions of these services rather than swapping an implementation behind an interface.

5. **Container naming is OrbStack-specific**: The `containerName()` utility in shared produces `.orb.local` URLs, which only work with OrbStack's DNS resolution. Preview URLs for a cloud provider would be completely different.

Developers need the option to run workspaces in cloud sandboxes (starting with Daytona) alongside the existing Docker flow, without breaking the current setup for users who prefer local containers.

## Solution

Introduce a **SandboxProvider** abstraction layer — an Effect service interface that both the existing Docker flow and a new Daytona cloud sandbox flow implement. Users choose their provider via a global default setting (in the app) with per-project overrides (in `laborer.json`).

When a workspace uses the Daytona provider:

1. Laborer creates a git worktree locally (existing behavior)
2. Creates a Daytona cloud sandbox using the `@daytonaio/sdk`, optionally building a snapshot with project dependencies pre-installed via Daytona's declarative Image builder
3. Pushes the worktree's HEAD to the sandbox via SSH-based git remote
4. The AI coding agent runs **inside** the sandbox — its built-in tools (read, write, bash, glob, grep) operate directly on the sandbox filesystem with real Linux inotify
5. The dev server also runs inside the sandbox with real file watchers and HMR
6. Terminals are displayed in the laborer UI via Daytona's WebSocket-based PTY sessions piped to xterm.js
7. Preview URLs come from Daytona's preview link system (e.g., `https://3000-abc123.preview.daytona.io`)
8. For local editor access, laborer automates VS Code Remote SSH configuration using Daytona's SSH gateway
9. Changes are pushed back to the host repo by the agent running `git push` inside the sandbox

The existing Docker flow continues to work unchanged. The provider choice is transparent to the UI — the same pause/resume buttons, terminal panes, and preview URL display work regardless of whether the sandbox is a local Docker container or a Daytona cloud sandbox.

As part of this work, the LiveStore schema columns are renamed from `container*` to `sandbox*` to be provider-agnostic.

## User Stories

1. As a developer, I want to choose between Docker (local) and Daytona (cloud) as my sandbox provider, so that I can use cloud sandboxes for heavy workloads without changing my workflow.

2. As a developer, I want to set a global default sandbox provider in the laborer app settings, so that all new workspaces use my preferred provider without per-project configuration.

3. As a developer, I want to override the global default with a `provider` field in `laborer.json`, so that specific projects can use a different provider than the global default.

4. As a developer, I want workspace creation to behave the same regardless of provider — create worktree, set up sandbox, push code, show terminal — so that switching providers doesn't require learning a new workflow.

5. As a developer, I want the AI coding agent (Claude Code, Codex, OpenCode) to run inside the Daytona sandbox, so that the agent's built-in file and shell tools operate directly on the sandbox filesystem without any custom tool wiring.

6. As a developer, I want the dev server to run inside the Daytona sandbox with real Linux inotify file watchers, so that HMR and hot reload work reliably regardless of how many concurrent workspaces I have.

7. As a developer, I want to see a clickable preview URL in the workspace UI when using Daytona, so that I can open the dev server in my browser just like I do with `.orb.local` URLs.

8. As a developer, I want terminal panes in the laborer UI to connect to Daytona sandbox PTY sessions over WebSocket, so that I can interact with sandbox terminals the same way I interact with Docker `exec` terminals.

9. As a developer, I want the pause/resume buttons to map to Daytona sandbox stop/start, so that idle sandboxes automatically free cloud resources and resume quickly when I need them.

10. As a developer, I want Daytona sandboxes to auto-stop after a configurable idle interval (default 15 minutes), so that I don't accumulate cloud costs from forgotten workspaces.

11. As a developer, I want laborer to push the worktree's current HEAD to the Daytona sandbox via SSH git remote on workspace creation, so that the sandbox starts with the correct code.

12. As a developer, I want the agent to push changes back from the sandbox to the host repo using standard `git push`, so that I control when and how changes are synced back.

13. As a developer, I want laborer to automatically configure `~/.ssh/config` entries for active Daytona sandboxes, so that I can open the sandbox in VS Code Remote SSH with a single click.

14. As a developer, I want the SSH config entries to be refreshed automatically when tokens expire, so that VS Code stays connected without manual intervention.

15. As a developer, I want laborer to detect whether the Daytona API is reachable and show a clear error if the API key is missing or invalid, so that I know what's wrong before workspace creation fails.

16. As a developer, I want project dependencies (node_modules) to be pre-installed in the Daytona sandbox image using the declarative Image builder, so that workspace creation is fast and I don't wait for `bun install` every time.

17. As a developer, I want the Daytona Image builder to use the project's lockfile hash as a cache key, so that images are only rebuilt when dependencies actually change.

18. As a developer, I want the sandbox to be destroyed when the workspace is destroyed, so that I don't accumulate orphaned cloud sandboxes.

19. As a developer, I want the LiveStore schema to use provider-agnostic column names (`sandboxId`, `sandboxUrl`, `sandboxStatus`), so that the UI code doesn't need Docker-specific or Daytona-specific branches.

20. As a developer, I want the existing Docker flow to continue working exactly as before after this change, so that no existing functionality is broken.

21. As a developer, I want workspace creation progress to show Daytona-specific steps (creating sandbox, pushing code, building image) in the same setup step indicator used for Docker, so that I can see what's happening during setup.

22. As a developer, I want the Daytona sandbox to use the default Daytona image (which includes Node 22, bun, Claude Code, OpenCode, Codex, git) unless I specify a custom image in `laborer.json`, so that most projects work out of the box.

23. As a developer, I want to be able to set Daytona sandbox resource limits (CPU, memory, disk) in `laborer.json`, so that I can right-size sandboxes for my project's needs.

24. As a developer, I want the RPC contract to use provider-agnostic names (`sandbox.pause`, `sandbox.resume`) instead of Docker-specific names, so that the client code is clean.

25. As a developer, I want state reconciliation on app startup to check Daytona sandbox states (via the SDK) and sync LiveStore, matching the existing Docker events listener behavior, so that the UI is always accurate.

## 'Polishing' Requirements

1. Verify that PTY sessions over WebSocket have acceptable latency for interactive terminal use — keystrokes should appear within 100ms.

2. Ensure preview URLs are displayed with the same visual treatment (clickable link, copy button, hover state) regardless of whether they're `.orb.local` URLs or Daytona preview URLs.

3. Confirm that the pause/resume UX feels consistent across providers — both should appear "instant" to the user (Docker unpause is <100ms, Daytona start is ~1-2s — if Daytona is noticeably slower, show a brief loading indicator).

4. Verify that workspace creation progress steps render smoothly in the UI when using Daytona, including any new steps like "pushing code to sandbox" or "building sandbox image".

5. Ensure that SSH config entries are cleaned up when workspaces are destroyed — no stale entries should accumulate in `~/.ssh/config`.

6. Verify that the schema rename (container* to sandbox*) does not break existing workspaces — old events with container* fields must still decode correctly via LiveStore's backward-compatible event schema evolution.

7. Confirm that the Image builder deps caching correctly detects lockfile changes and only rebuilds when necessary.

8. Ensure that Daytona API errors (rate limits, timeouts, auth failures) are surfaced clearly in the UI with actionable guidance, not swallowed as generic "workspace creation failed" errors.

9. Verify that multiple concurrent Daytona workspace creations don't hit API rate limits — test with 5+ simultaneous creates.

10. Ensure that the VS Code SSH automation handles edge cases: multiple sandboxes on the same SSH gateway, token rotation while VS Code is connected, and SSH config file that already has custom entries.

## Implementation Decisions

### SandboxProvider Abstraction

A new `SandboxProvider` Effect service interface abstracts the lifecycle, terminal, preview URL, and state reconciliation operations that differ between Docker and Daytona. Both the existing Docker implementation and the new Daytona implementation conform to this interface.

The interface covers:
- **Lifecycle**: `createSandbox`, `destroySandbox`, `pauseSandbox`, `resumeSandbox`
- **Terminal**: `spawnTerminal` (returns a handle compatible with the existing PTY system)
- **Preview URLs**: `getPreviewUrl(workspaceId, port)`
- **State reconciliation**: `reconcileState` (called at startup to sync LiveStore with actual provider state)
- **Availability check**: `checkAvailability` (replaces the current `DockerDetection` service)

The `WorkspaceProvider` is modified to accept a `SandboxProvider` in its layer dependencies instead of directly depending on `ContainerService` + `DepsImageService` + `DockerDetection`. The `performContainerSetup` method becomes `performSandboxSetup` and delegates to whichever provider is configured.

### Provider Resolution

Provider selection follows a two-tier precedence:
1. Per-project: `laborer.json` `devServer.provider` field (`"docker"` or `"daytona"`)
2. Global default: An `appSettings` key `defaultSandboxProvider` in LiveStore (set via a UI setting)

If neither is set, the default is `"docker"` (preserving existing behavior). The `ConfigService` resolves the effective provider by checking per-project first, then global default.

### LiveStore Schema Evolution

The columns `containerId`, `containerUrl`, `containerPort`, `containerImage`, `containerStatus`, `containerSetupStep` are renamed to `sandboxId`, `sandboxUrl`, `sandboxPort`, `sandboxImage`, `sandboxStatus`, `sandboxSetupStep`.

Since LiveStore's eventlog is immutable:
- **Existing events** (`v1.ContainerStarted`, `v1.ContainerStopped`, etc.) remain with their original field names. Their materializers are updated to write to the new column names.
- **New events** (`v2.SandboxStarted`, `v2.SandboxStopped`, `v2.SandboxPaused`, `v2.SandboxResumed`, `v2.SandboxSetupStepChanged`) use the new naming and are emitted going forward.
- Old `v1.Container*` events keep no-op or bridging materializers so existing eventlog data still replays correctly.

### RPC Contract Changes

Container-specific RPCs are renamed to be provider-agnostic:
- `container.pause` becomes `sandbox.pause`
- `container.unpause` becomes `sandbox.resume`
- `container.setPort` becomes `sandbox.setPort`
- `docker.status` becomes `sandbox.providerStatus`
- `workspace.startContainer` becomes `workspace.startSandbox`

Old RPC names are kept as aliases during a deprecation period to avoid breaking in-flight client code.

### Daytona Sandbox Lifecycle

**Creation**:
1. `WorkspaceProvider.createWorktree` creates the local git worktree (unchanged)
2. `DaytonaSandboxProvider.createSandbox` is called with the workspace config
3. Uses the Daytona SDK to create a sandbox, optionally from a cached snapshot built via the Image builder with the project's lockfile-hashed dependencies
4. Gets SSH access via `sandbox.createSshAccess()`
5. Pushes the worktree's HEAD to the sandbox via `git push sandbox-{n} HEAD:main` over the SSH remote
6. Commits a `SandboxStarted` event to LiveStore with the sandbox ID and preview URL base

**Pause (auto-stop)**:
- Daytona's `autoStopInterval` is set on sandbox creation (default 15 minutes)
- When Daytona auto-stops the sandbox, the reconciliation loop detects the state change and commits `SandboxPaused` to LiveStore
- Manual pause via the UI calls `sandbox.stop()` via the SDK

**Resume**:
- Manual resume calls `sandbox.start()` via the SDK (~1-2s)
- The UI shows a brief loading state during resume

**Destroy**:
- Calls `sandbox.delete()` via the SDK
- Cleans up the SSH config entry
- Commits `SandboxStopped` to LiveStore

### Terminal Integration

For Docker workspaces, terminals continue to use `docker exec -it {containerName} /bin/sh` via the existing PTY system.

For Daytona workspaces, the `SandboxProvider.spawnTerminal` method creates a Daytona PTY session via `sandbox.process.createPty()`. The WebSocket-based PTY data is bridged to the existing xterm.js terminal component:
- `onData` from Daytona PTY pipes to `xterm.Terminal.write()`
- `xterm.onData` pipes to `ptyHandle.sendInput()`
- Resize events pipe to `ptyHandle.resize()`

This bridge lives in the Daytona provider implementation, not in the shared terminal infrastructure. The terminal-client sees both Docker and Daytona terminals as the same abstract handle.

### Git Sync Strategy

**Into the sandbox** (on workspace creation):
1. Get SSH access: `sandbox.createSshAccess(10)` returns a token and SSH URL
2. Add a git remote to the local worktree: `git remote add sandbox-{n} ssh://{token}@ssh.app.daytona.io/home/daytona/project`
3. Push: `git push sandbox-{n} HEAD:main`
4. Inside the sandbox: `git checkout main` (the sandbox already has a git repo from the push)

**Out of the sandbox** (agent pushes):
- The agent running inside the sandbox uses `git push` to push to the origin remote (GitHub, etc.)
- Laborer does not auto-pull from the sandbox. The user's local worktree can fetch from the remote when they want to see the changes.

### VS Code Remote SSH Automation

When a Daytona workspace is created or resumed:
1. `sandbox.createSshAccess()` returns a token, SSH command, and expiry
2. Laborer writes/updates an entry in `~/.ssh/config`:
   ```
   Host laborer-{workspaceId}
     HostName ssh.app.daytona.io
     Port 2222
     User {token}
     StrictHostKeyChecking no
     UserKnownHostsFile /dev/null
   ```
3. The UI shows an "Open in VS Code" button that runs `code --remote ssh-remote+laborer-{workspaceId} /home/daytona/project`
4. A background fiber refreshes the SSH token before expiry and updates the config entry

When a workspace is paused or destroyed, the SSH config entry is removed.

### Daytona Image Builder for Dependencies

When `devServer.installCommand` is configured in `laborer.json`, the Daytona provider uses the Image builder to create a snapshot with pre-installed dependencies:

1. Start from the default Daytona base image (or `devServer.image` if specified)
2. Add a `runCommands` step with the install command (e.g., `bun install --frozen-lockfile`)
3. Hash the project's lockfile to generate a snapshot name: `laborer-{projectSlug}-{lockfileHash}`
4. Check if a snapshot with that name already exists via `daytona.snapshot.get()`
5. If not, create the snapshot via `daytona.snapshot.create()` and stream build logs to the UI
6. Create the sandbox from the cached snapshot

This mirrors the existing `DepsImageService` pattern but uses Daytona's infrastructure instead of `docker run` + `docker commit`.

### Environment Variables

The `packages/env` package is extended with:
- `DAYTONA_API_KEY`: API key for the Daytona SDK (already in `.env.local`)
- `DAYTONA_API_URL`: API URL for the Daytona SDK (already in `.env.local`)
- `DAYTONA_TARGET`: Optional region target (default: `"us"`)

These are loaded via `@t3-oss/env-core` with Zod validation, consistent with existing env vars.

### State Reconciliation

On app startup, the Daytona provider:
1. Queries LiveStore for all workspaces with a `sandboxId` and `sandboxProvider === 'daytona'`
2. For each, calls `daytona.get(sandboxId)` to check the actual state
3. If the sandbox is stopped but LiveStore says running, commits `SandboxPaused`
4. If the sandbox is destroyed/not found, commits `SandboxStopped`
5. If the sandbox is running but LiveStore says paused, commits `SandboxResumed`

This replaces the `docker events` listener approach. Since Daytona doesn't have a real-time event stream, the reconciliation runs on a polling interval (every 30 seconds) as a daemon fiber.

### Config Schema Changes

The `DevServerConfig` in `config-service.ts` gains:
- `provider?: "docker" | "daytona"` — sandbox provider for this project
- `resources?: { cpu?: number; memory?: number; disk?: number }` — Daytona sandbox resource limits
- `autoStopInterval?: number` — minutes of inactivity before auto-stop (Daytona only, default 15)

### Workspace Table Changes

A new column `sandboxProvider` is added to the workspaces table to record which provider was used. This is set at creation time and does not change.

## Testing Decisions

Good tests verify external behavior through the public service interfaces, not internal implementation details like Docker CLI arguments or Daytona SDK method calls.

### Modules to test

1. **SandboxProvider interface contract** — Create a test suite that runs against the interface itself. Both the Docker and Daytona implementations should pass the same behavioral tests (create returns a sandbox ID, pause transitions state, destroy cleans up). For the Daytona implementation, these are integration tests requiring API access. For Docker, they require Docker to be running. Both suites should be tagged as integration tests and skippable in CI without credentials.

2. **Provider resolution logic** — Unit tests for the config precedence: per-project overrides global, global overrides default, default is "docker". Pure logic, no external dependencies.

3. **Schema evolution** — Unit tests verifying that old `v1.Container*` events still materialize correctly into the renamed `sandbox*` columns. This is critical for backward compatibility and can be tested against LiveStore in-memory.

4. **Git sync helpers** — Unit tests for SSH remote URL construction, git push command building, and SSH config entry generation/cleanup. Pure string manipulation, easy to test in isolation.

5. **Image builder cache key generation** — Unit tests for lockfile hashing and snapshot name generation. Pure functions.

6. **RPC alias backward compatibility** — Unit tests verifying that both old (`container.pause`) and new (`sandbox.pause`) RPC names route to the same handler.

### Prior art


## Out of Scope

- **Self-hosted Daytona**: This PRD targets Daytona's hosted API (`app.daytona.io`). Self-hosting is a future optimization using the open-source Daytona runner.

- **Bidirectional file sync**: No real-time file sync between host and sandbox. Code goes in via git push, comes out via the agent's `git push` to origin. No SSHFS, no file watcher sync.

- **Auto-pull from sandbox**: Laborer does not automatically pull sandbox changes to the local worktree. The agent pushes to origin; the user pulls from origin.

- **Other sandbox providers**: Only Docker and Daytona are implemented. The interface is designed for future providers (Fly Machines, E2B, CodeSandbox) but none are built.


- **Container-to-sandbox migration**: Existing Docker workspaces cannot be converted to Daytona workspaces in-place. Users create new workspaces with the new provider.

- **Multi-region support**: Sandboxes always target the `"us"` region initially. Multi-region is a future enhancement.

- **Cost monitoring / billing dashboard**: No UI for tracking Daytona usage or costs.

- **Daytona Volumes**: Volume mounting for persistent storage across sandbox recreations is not included in v1.

- **ComputerUse / Desktop automation**: Daytona's browser automation capabilities are not used.

## Further Notes

- **Daytona SDK reference**: The full TypeScript SDK is cloned at `.reference/daytona/libs/sdk-typescript/`. Key files: `Daytona.ts` (client), `Sandbox.ts` (lifecycle + preview), `Process.ts` (exec + PTY), `FileSystem.ts` (file ops), `Git.ts` (git ops), `Image.ts` (image builder), `Snapshot.ts` (snapshot service).

- **Default sandbox image contents**: The default Daytona sandbox image already includes Node 22, bun, git, Claude Code (`@anthropic-ai/claude-code`), OpenCode (`opencode-ai`), Codex, and Python. Most projects should work without a custom image.

- **SSH token lifetime**: Daytona SSH tokens have a configurable expiry. The VS Code SSH automation should request tokens with a 60-minute expiry and refresh them at the 45-minute mark to avoid disconnections.

- **PTY over WebSocket**: Daytona PTY sessions use WebSocket connections at `wss://<toolboxProxyUrl>/<sandboxId>/process/pty/<sessionId>/connect`. Authentication is via Bearer token in headers (Node.js) or `DAYTONA_SANDBOX_AUTH_KEY` query parameter (browser). The `lazyStart: true` default defers PTY startup until the first WebSocket client connects.

- **Auto-stop vs auto-archive vs auto-delete**: Daytona has three idle intervals. For laborer's use case: `autoStopInterval` = 15 minutes (pause idle sandboxes), `autoArchiveInterval` = 7 days (archive long-idle sandboxes), `autoDeleteInterval` = -1 (never auto-delete, let laborer manage lifecycle).

- **Cost estimate**: At ~$0.166/hr per sandbox (2 vCPU / 4GB RAM) with auto-stop after 15 minutes of idle, 20 bursty workspaces averaging ~26 active hours/month each = ~$88/month. Daytona has no platform fee and offers $200 in free credits.

- **Event schema evolution**: When renaming columns, old `v1.Container*` events must continue to decode. The materializers for these events are updated to write to the new `sandbox*` column names. New `v2.Sandbox*` events are used going forward. Both old and new events coexist in the eventlog indefinitely.
