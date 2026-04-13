# PRD: Shuru Sandbox Provider

## Problem Statement

Laborer already supports two sandbox shapes for dev servers:

1. `docker` for local containers, which works well on supported machines but still depends on the local Docker/OrbStack stack.
2. `daytona` for cloud sandboxes, which moves the workload off the host but changes the locality and failure modes of the development loop.

There is currently no **local microVM** option that sits between those two extremes.

That leaves a gap for users who want:

1. Real Linux file watchers and dev-server isolation on their own machine.
2. A provider that still uses Laborer's existing local git worktree flow.
3. A provider that only owns the dev-server environment while regular interactive terminals remain local.
4. A path away from Docker/OrbStack for local isolation without taking on the cloud and sync model of Daytona.

[`shuru`](https://github.com/superhq-ai/shuru) is a good fit for that gap. It provides local-first Linux microVMs on macOS with read-only mounts, overlay writes, checkpointing, port forwarding, and a stdio JSON-RPC interface that Laborer can drive locally.

## Solution

Add `shuru` as a third `SandboxProvider` implementation alongside `docker` and `daytona`.

When a workspace uses `shuru`:

1. Laborer keeps using the existing local git worktree flow.
2. Workspace creation eagerly boots a local `shuru` microVM and records sandbox state in LiveStore.
3. The worktree is mounted into the VM at `/workspace` as a **read-only mount with overlay writes**, so sandbox-generated files remain VM-private.
4. Laborer auto-allocates a host preview port and forwards it to the configured guest port.
5. The preview URL is exposed as a localhost URL such as `http://127.0.0.1:45673`.
6. Only the dev-server terminal runs inside `shuru`; normal workspace terminals stay on the host exactly as they do today.
7. Dependency installs and similar setup are cached in a shared checkpoint keyed by lockfile and sandbox-relevant config.
8. Pause/resume is implemented with checkpoint/restore, not container-style pause.
9. `shuru` is available as both a per-project provider and a global default provider.
10. On unsupported or unconfigured machines, `shuru` is still shown in the UI but disabled with a clear reason.

## User Stories

1. As a developer, I want to choose `shuru` as a sandbox provider per project, so I can use a local microVM for dev-server isolation.
2. As a developer, I want to set `shuru` as my global default sandbox provider, so new workspaces use it automatically.
3. As a developer, I want Laborer to clearly tell me when `shuru` is unavailable, so I know whether the problem is platform support, missing installation, or some other local setup issue.
4. As a developer, I want a `shuru` workspace to keep using Laborer's existing local git worktree, so my local repo workflow does not change.
5. As a developer, I want workspace creation to eagerly boot the `shuru` VM, so the sandbox is ready as part of normal workspace setup.
6. As a developer, I want preview URLs to open on `localhost` with automatically allocated host ports, so multiple workspaces can expose the same guest port without colliding.
7. As a developer, I want only the dev-server terminal to run inside `shuru`, so my regular terminals keep using the host shell and local tools.
8. As a developer, I want dependency installs and similar sandbox setup to persist across boots through checkpoint caching, so startup stays fast.
9. As a developer, I want checkpoint caches to rebuild automatically when the lockfile or relevant sandbox config changes, so stale dependencies do not linger.
10. As a developer, I want pause/resume to preserve VM-private state through checkpoint/restore, so I can stop local compute without losing sandbox-local setup.
11. As a developer, I want sandbox-generated files and caches to stay private to the VM, so the host worktree remains untouched unless I explicitly change files on the host.
12. As a developer, I want Laborer to recover cleanly from failed or stale `shuru` sessions, so retries and restarts do not leave the UI in a misleading state.
13. As a developer, I want host terminals and non-sandboxed workflows to behave exactly as they do today, so adding `shuru` does not change unrelated behavior.

## Polishing Requirements

1. `shuru` should appear as a first-class provider in settings and project configuration, but show a disabled state plus guidance when unsupported or not installed.
2. Preview URLs should feel equivalent to existing sandbox previews even though they use `localhost` rather than `.orb.local` or Daytona preview domains.
3. Workspace creation progress should expose Shuru-specific steps such as `checking-shuru`, `restoring-checkpoint`, `building-base-checkpoint`, `starting-shuru`, and `allocating-port`.
4. The dev-server pane should make it clear that the Shuru-backed process is a sandboxed dev-server session, not a general-purpose host terminal.
5. Pause/resume should feel predictable: pause creates a checkpoint and stops the VM; resume restores from the most recent workspace checkpoint when available.
6. Startup reconciliation should leave no stale `running` Shuru sandboxes in LiveStore after the app restarts.

## Implementation Decisions

### Provider Surface

- Extend provider enums and config validation from `docker | daytona` to `docker | daytona | shuru`.
- `shuru` may be selected per project and as the global default provider.
- Availability is platform- and installation-aware:
  - Supported only on macOS 14+ on Apple Silicon.
  - Requires an installed `shuru` binary discoverable on `PATH`.
- When unavailable, `shuru` remains visible in the UI but disabled with a concrete reason.

### Runtime Integration

- Laborer will **not** use the current `@superhq/shuru` JS SDK directly in the server process.
- The integration target is the `shuru` CLI driven through `shuru run --stdio`.
- Implement a deep module such as `ShuruClient` that owns:
  - spawning the `shuru` child process,
  - speaking its JSON-RPC protocol over stdin/stdout,
  - tracking long-running spawned processes,
  - stopping and cleaning up the VM process.
- The provider will treat each live VM as process-owned and local to the current server session.

### Filesystem Model

- Laborer continues to create and manage the local git worktree exactly as it does today.
- The `shuru` VM mounts that worktree into `/workspace` using the default read-only mount behavior.
- Writes made inside the VM land in overlay storage and checkpoint data, not in the host worktree.
- This allows `devServer.setupScripts`, dependency installs, and runtime-generated files to work inside the VM without mutating host files.

### Preview URLs and Port Allocation

- The configured guest port remains the app-facing port from `devServer.port`.
- Laborer auto-allocates an available host port for each `shuru` workspace.
- The provider records:
  - `sandboxUrl = "127.0.0.1"`
  - `sandboxPort = <allocated host port>`
- `getPreviewUrl()` returns `http://127.0.0.1:<hostPort>`.
- Host port reuse is not required across workspaces; isolation is more important than stable port numbers.

### Dev-Server Terminal Model

- `shuru` is used only for the dev-server process in v1.
- Regular terminals remain host-local through the existing `TerminalClient` path.
- Because the `shuru --stdio` protocol is process-stream oriented rather than PTY-oriented, the Shuru dev-server pane is a **stream-backed terminal/log session**:
  - stdout and stderr stream into the UI,
  - stdin can be forwarded when needed,
  - kill/stop is supported,
  - resize is a no-op.
- This limitation is acceptable because v1 only uses `shuru` for long-running dev-server processes, not for general interactive shells.

### Boot Timing

- `shuru` workspaces boot eagerly during workspace creation when `devServer.provider` resolves to `shuru`.
- `workspace.startSandbox` must also support the Shuru path for retries and for workspaces that were created without a running sandbox.

### Checkpoint Strategy

Use two checkpoint layers:

1. **Shared base checkpoint** per project/config hash.
   - Built from the mounted worktree plus install/setup commands needed to prepare dependencies.
   - Keyed by inputs such as lockfile hash, `devServer.installCommand`, relevant setup commands, and other sandbox-relevant config.
2. **Workspace runtime checkpoint** per workspace.
   - Captured when pausing a live Shuru sandbox.
   - Restored first on resume; falls back to the shared base checkpoint when absent.

Checkpoint invalidation is automatic. When the lockfile or relevant config changes, the shared base checkpoint is treated as stale and rebuilt.

### Pause and Resume

- `pauseSandbox(workspaceId)`:
  - checkpoints the workspace runtime layer,
  - stops the live `shuru` VM,
  - updates LiveStore to `sandboxStatus = 'paused'`.
- `resumeSandbox(workspaceId)`:
  - restores the workspace runtime checkpoint if present,
  - otherwise restores the current shared base checkpoint,
  - returns the workspace to `sandboxStatus = 'running'`.

### State Reconciliation

- Shuru runtime handles are in-memory and tied to the current server session.
- On app startup, any workspace that says `sandboxProvider = 'shuru'` but has no live runtime in the current process is reconciled away from `running`.
- Reconciliation should preserve enough state for the user to retry or resume, but it must not leave fake live sandboxes in the UI.

### Unsupported / Unused Config Fields

- `devServer.image` and `devServer.dockerfile` do not apply to `shuru` in v1.
- `devServer.network` as currently defined for Docker networking does not apply to `shuru` in v1.
- Existing CPU/memory/disk resource settings may be reused where they already exist, but no new provider-specific config surface is required for the first slice.

## Testing Decisions

Follow TDD and tracer-bullet slices.

1. Start with behavior through public interfaces, not implementation details.
2. Prefer service-level tests over tests that assert raw CLI argument arrays or child-process internals.
3. Use one narrow end-to-end test per slice before broadening behavior.
4. For the Shuru client layer, use a fake or mock `shuru --stdio` process to exercise the JSON-RPC contract.
5. For provider behavior, test through `SandboxProvider`, `WorkspaceProvider`, RPC handlers, and UI integration points rather than private helpers.

Recommended test categories:

1. Provider/config tests for selecting `shuru`, global default resolution, and disabled-state behavior.
2. `ShuruClient` protocol tests for ready, spawn, output streaming, kill, watch, checkpoint, and stop behavior.
3. Provider lifecycle tests for create, destroy, preview URL generation, pause, resume, and reconciliation.
4. Terminal routing tests verifying that only dev-server sessions use the Shuru path while normal terminals remain host-local.
5. Cache invalidation tests covering lockfile/config hash changes.

## Out of Scope

1. Cross-platform Shuru support outside macOS 14+ Apple Silicon.
2. Direct use of the Bun-oriented JS SDK inside Laborer's Node server.
3. A true PTY-backed interactive Shuru terminal.
4. Manual extra Shuru terminals beyond the dev-server session.
5. Host-write mode for the mounted worktree.
6. Custom preview hostnames or reverse-proxy domains for Shuru previews.
7. Auto-syncing VM-private files back into the host worktree.

## Further Notes

1. Local reference repo: `.reference/shuru/`.
2. Prior art app integration: `.reference/superhq/`.
3. Relevant Shuru capabilities already validated in reference/docs:
   - read-only mounts with overlay writes,
   - host-to-guest port forwarding,
   - checkpoint create/restore,
   - stdio JSON-RPC process streaming.
4. The current `shuru --stdio` protocol supports spawned process streaming and stdin/kill, but not PTY resize semantics. That is why v1 limits Shuru to the dev-server session.
