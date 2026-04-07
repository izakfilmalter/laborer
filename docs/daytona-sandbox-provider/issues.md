# Issues: Daytona Sandbox Provider

## Issue 1: Schema rename — container* columns to sandbox*

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Rename the six `container*` columns in the `workspaces` LiveStore table to `sandbox*`: `containerId` -> `sandboxId`, `containerUrl` -> `sandboxUrl`, `containerPort` -> `sandboxPort`, `containerImage` -> `sandboxImage`, `containerStatus` -> `sandboxStatus`, `containerSetupStep` -> `sandboxSetupStep`.

Add a new `sandboxProvider` column (`text({ nullable: true })`) to record which provider was used for a workspace (`"docker"` or `"daytona"`). This is set at creation time.

Update the `WorkspaceCreated` materializer to initialize the new column names with null defaults. Update all existing materializers that reference `container*` columns to use the new `sandbox*` names instead.

The existing `v1.Container*` event definitions must remain in the schema (LiveStore requires all previously-used event definitions to exist), but their materializers are updated to write to the renamed columns. For example, `v1.ContainerStarted` now writes to `sandboxId`, `sandboxUrl`, `sandboxImage`, `sandboxStatus` instead of the old column names.

TDD approach: Write a test that materializes a `v1.ContainerStarted` event and verifies the workspace row has the new `sandbox*` columns populated. Then write a test that verifies a `v1.WorkspaceCreated` event initializes all `sandbox*` columns to null. Only then implement the column renames and materializer updates.

### Acceptance criteria

- [ ] `workspaces` table columns renamed: `containerId` -> `sandboxId`, `containerUrl` -> `sandboxUrl`, `containerPort` -> `sandboxPort`, `containerImage` -> `sandboxImage`, `containerStatus` -> `sandboxStatus`, `containerSetupStep` -> `sandboxSetupStep`
- [ ] New `sandboxProvider` column added (`text({ nullable: true })`)
- [ ] `WorkspaceCreated` materializer initializes all `sandbox*` columns to null and `sandboxProvider` to null
- [ ] Existing `v1.Container*` event materializers updated to write to `sandbox*` columns
- [ ] Old `v1.Container*` event definitions retained (not deleted) for backward compatibility
- [ ] All server-side code that reads `container*` columns updated to read `sandbox*` columns
- [ ] Unit tests verify old events materialize into new column names correctly
- [ ] Type checks pass (`bun run check-types`)
- [ ] `bun run format` passes

### Blocked by

None — can start immediately.

### User stories addressed

- User story 19

---

## Issue 2: Schema — new v2.Sandbox* events + bridging materializers

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Define new `v2.Sandbox*` events that use provider-agnostic naming. These are the events emitted going forward by both the Docker and Daytona providers:

- `v2.SandboxStarted` — fields: `workspaceId`, `sandboxId`, `sandboxUrl`, `sandboxImage`, `sandboxPort?`, `sandboxProvider`
- `v2.SandboxStopped` — fields: `workspaceId`
- `v2.SandboxPaused` — fields: `workspaceId`
- `v2.SandboxResumed` — fields: `workspaceId`
- `v2.SandboxSetupStepChanged` — fields: `workspaceId`, `step`
- `v2.SandboxPortChanged` — fields: `workspaceId`, `sandboxPort`

Write materializers for each new event that update the `sandbox*` columns in the workspaces table. The old `v1.Container*` materializers remain as-is (from Issue 1) for backward compatibility with existing eventlog data.

Add all new events to the `events` export object.

TDD approach: Write tests that emit each new `v2.Sandbox*` event and verify the workspace row is updated correctly. Start with `v2.SandboxStarted` as the tracer bullet — verify it sets `sandboxId`, `sandboxUrl`, `sandboxImage`, `sandboxStatus = 'running'`, and `sandboxProvider`. Then add tests for each remaining event.

### Acceptance criteria

- [ ] `v2.SandboxStarted` event defined with `workspaceId`, `sandboxId`, `sandboxUrl`, `sandboxImage`, `sandboxPort?`, `sandboxProvider` fields
- [ ] `v2.SandboxStopped` event defined with `workspaceId` field
- [ ] `v2.SandboxPaused` event defined with `workspaceId` field
- [ ] `v2.SandboxResumed` event defined with `workspaceId` field
- [ ] `v2.SandboxSetupStepChanged` event defined with `workspaceId`, `step` fields
- [ ] `v2.SandboxPortChanged` event defined with `workspaceId`, `sandboxPort` fields
- [ ] Materializers write to `sandbox*` columns correctly
- [ ] `v2.SandboxStarted` materializer sets `sandboxProvider` column
- [ ] Both old `v1.Container*` and new `v2.Sandbox*` events coexist in the schema
- [ ] All new events added to the `events` export object
- [ ] Unit tests for each new event's materialization
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Schema rename — container* columns to sandbox*" (Issue 1)

### User stories addressed

- User story 19

---

## Issue 3: RPC rename — container.* to sandbox.* with backward-compat aliases

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Rename the container-specific RPCs in the shared RPC contract to provider-agnostic names:

- `container.pause` -> `sandbox.pause`
- `container.unpause` -> `sandbox.resume`
- `container.setPort` -> `sandbox.setPort`
- `docker.status` -> `sandbox.providerStatus`
- `workspace.startContainer` -> `workspace.startSandbox`

Keep the old RPC names as aliases that route to the same handlers. This ensures any in-flight client code (e.g., the web app in an older Electron window) continues to work during the transition.

Update the RPC handlers in `packages/server/src/rpc/handlers.ts` to use the new names internally while supporting both old and new names from clients.

TDD approach: Write a test that calls the new `sandbox.pause` RPC name and verifies it reaches the handler. Then write a test that calls the old `container.pause` name and verifies it still works. Implement the aliases.

### Acceptance criteria

- [ ] New RPC names defined in the shared contract: `sandbox.pause`, `sandbox.resume`, `sandbox.setPort`, `sandbox.providerStatus`, `workspace.startSandbox`
- [ ] Old RPC names (`container.pause`, `container.unpause`, `container.setPort`, `docker.status`, `workspace.startContainer`) still resolve to the same handlers
- [ ] RPC handlers updated to use new internal naming
- [ ] Response types unchanged (backward compatible)
- [ ] Unit tests verify both old and new RPC names work
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Schema — new v2.Sandbox* events + bridging materializers" (Issue 2)

### User stories addressed

- User story 24

---

## Issue 4: UI — update all components to use sandbox* column names + RPC names

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Update all web UI components and hooks that reference `container*` LiveStore columns or `container.*` RPC names to use the new `sandbox*` naming.

This includes:
- `workspace-list.tsx` — any references to `containerStatus`, `containerUrl`, `containerSetupStep`
- `workspace-dashboard.tsx` — container status display
- `workspace-frame-header.tsx` — preview URL display and copy button
- `project-settings-modal.tsx` — any container config display
- Any hooks that call `container.pause`, `container.unpause`, `container.setPort`, `docker.status`, `workspace.startContainer`
- Any LiveStore queries that read `container*` columns

The UI should reference only the new `sandbox*` names. The old `container*` columns no longer exist in the schema after Issue 1.

TDD approach: Existing UI tests that reference `containerStatus` etc. should be updated first (RED: they fail because the columns are renamed). Then update the components (GREEN).

### Acceptance criteria

- [ ] All web UI components reference `sandbox*` columns instead of `container*`
- [ ] All RPC calls use new names (`sandbox.pause` instead of `container.pause`, etc.)
- [ ] LiveStore queries reference `sandboxStatus`, `sandboxUrl`, `sandboxId`, etc.
- [ ] No references to `container*` column names remain in `apps/web/`
- [ ] Existing UI tests updated and passing
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "RPC rename — container.* to sandbox.* with backward-compat aliases" (Issue 3)

### User stories addressed

- User story 19
- User story 24

---

## Issue 5: Provider config — add provider field to laborer.json + config resolution

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Extend the `DevServerConfig` type in `config-service.ts` with a `provider` field: `provider?: "docker" | "daytona"`. This allows per-project provider selection in `laborer.json`:

```json
{
  "devServer": {
    "provider": "daytona",
    "image": "node:22",
    "startCommand": "bun dev"
  }
}
```

Also add optional resource limit fields for Daytona: `resources?: { cpu?: number; memory?: number; disk?: number }` and `autoStopInterval?: number`.

The `provider` field follows the existing layered resolution pattern (project -> ancestors -> global -> default). The default is `undefined` (which will be resolved against the global default in a later issue). Validation: `provider` must be `"docker"` or `"daytona"` if specified.

Extend `writeProjectConfig` to support writing the new fields. Extend `ConfigResponse` in the RPC contract to include the new fields.

TDD approach: Write a config resolution test that sets `devServer.provider: "daytona"` in a project config and verifies it resolves correctly. Write a validation test that rejects `provider: "invalid"`. Then implement.

### Acceptance criteria

- [ ] `DevServerConfig` gains `provider?: "docker" | "daytona"` field
- [ ] `DevServerConfig` gains `resources?: { cpu?: number; memory?: number; disk?: number }` field
- [ ] `DevServerConfig` gains `autoStopInterval?: number` field
- [ ] `ResolvedLaborerConfig` includes resolved values for the new fields
- [ ] Layered resolution works for `provider` (project overrides ancestor overrides global)
- [ ] Validation rejects invalid `provider` values
- [ ] `writeProjectConfig` supports the new fields
- [ ] `ConfigResponse` RPC schema includes the new fields
- [ ] Unit tests for provider config parsing, validation, and resolution
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Schema rename — container* columns to sandbox*" (Issue 1)

### User stories addressed

- User story 2
- User story 3

---

## Issue 6: Provider config — global default sandbox provider in appSettings

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Add a `defaultSandboxProvider` key to the `appSettings` LiveStore table. This stores the global default sandbox provider (`"docker"` or `"daytona"`).

Add a new `AppSettingChanged` event usage for this key (the event already exists, just emit it with key `"defaultSandboxProvider"`).

Add a new RPC `settings.getDefaultProvider` and `settings.setDefaultProvider` that reads/writes this setting. Expose it in the project settings UI as a dropdown.

Implement the resolution logic: when `ConfigService.resolveConfig` encounters a workspace without a per-project `provider` setting, it falls back to the global default from `appSettings`. If neither is set, default is `"docker"`.

TDD approach: Write a test that sets the global default to `"daytona"` and verifies config resolution falls back to it when no per-project provider is set. Write a test that verifies per-project overrides the global. Then implement.

### Acceptance criteria

- [ ] `defaultSandboxProvider` key recognized in `appSettings`
- [ ] New RPCs: `settings.getDefaultProvider` returns current default, `settings.setDefaultProvider` updates it
- [ ] Config resolution: per-project `devServer.provider` overrides global `defaultSandboxProvider` overrides hardcoded `"docker"`
- [ ] UI: dropdown in settings area to select global default provider
- [ ] Unit tests for the resolution precedence chain
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Provider config — add provider field to laborer.json + config resolution" (Issue 5)

### User stories addressed

- User story 2

---

## Issue 7: Daytona env vars in packages/env

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Extend the `packages/env` server environment schema to include Daytona-specific variables:

- `DAYTONA_API_KEY` — required when Daytona provider is used, optional otherwise
- `DAYTONA_API_URL` — optional, defaults to `"https://app.daytona.io/api"`
- `DAYTONA_TARGET` — optional, defaults to `"us"`

These are loaded via `@t3-oss/env-core` with Zod validation, consistent with existing env vars like `TERMINAL_GRACE_PERIOD_MS`. The variables should be optional at the schema level (not every user has Daytona credentials) but validated at runtime when the Daytona provider is actually used.

The `.env.local` file already contains `DAYTONA_API_KEY` and `DAYTONA_API_URL`.

TDD approach: Write a test that verifies the env schema accepts valid Daytona env vars. Write a test that verifies default values work when vars are not set. Then implement.

### Acceptance criteria

- [ ] `packages/env/src/server.ts` exports `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET`
- [ ] `DAYTONA_API_KEY` is optional at the schema level
- [ ] `DAYTONA_API_URL` defaults to `"https://app.daytona.io/api"`
- [ ] `DAYTONA_TARGET` defaults to `"us"`
- [ ] Zod validation for each variable
- [ ] Unit tests for env parsing with and without Daytona vars
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

None — can start immediately.

### User stories addressed

- User story 15

---

## Issue 8: SandboxProvider Effect interface definition

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Define the `SandboxProvider` Effect `Context.Tag` interface in a new file `packages/server/src/services/sandbox-provider.ts`. This is the abstraction that both Docker and Daytona implement.

The interface covers:
- `createSandbox(params: CreateSandboxParams) => Effect<void, RpcError>` — provision a sandbox for a workspace
- `destroySandbox(workspaceId: string) => Effect<void, RpcError>` — tear down a sandbox
- `pauseSandbox(workspaceId: string) => Effect<void, RpcError>` — pause/stop the sandbox
- `resumeSandbox(workspaceId: string) => Effect<void, RpcError>` — resume/start the sandbox
- `getPreviewUrl(workspaceId: string, port: number) => Effect<string, RpcError>` — get a preview URL for a port
- `spawnTerminal(workspaceId: string, opts?: TerminalOpts) => Effect<TerminalHandle, RpcError>` — spawn a terminal in the sandbox
- `reconcileState() => Effect<void>` — sync LiveStore with actual provider state
- `checkAvailability() => Effect<{ available: boolean; error?: string }>` — check if the provider is available

Define the `CreateSandboxParams`, `TerminalOpts`, and `TerminalHandle` types. `TerminalHandle` should be a minimal interface that the terminal system can work with regardless of provider.

This is an interface-only issue — no implementation. The interface should be designed as a deep module: small surface area, each method hides significant provider-specific complexity.

TDD approach: No behavioral tests for a pure interface definition. Write type-level tests (or compile-time checks) that verify the interface is well-typed. The real behavioral tests come in Issues 9 and 13.

### Acceptance criteria

- [ ] `SandboxProvider` Effect Context.Tag defined in `packages/server/src/services/sandbox-provider.ts`
- [ ] Interface includes: `createSandbox`, `destroySandbox`, `pauseSandbox`, `resumeSandbox`, `getPreviewUrl`, `spawnTerminal`, `reconcileState`, `checkAvailability`
- [ ] `CreateSandboxParams` type defined with workspace ID, branch name, project name, worktree path, dev server config
- [ ] `TerminalHandle` type defined with minimal interface for PTY interaction
- [ ] Types exported for use by both Docker and Daytona implementations
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Schema — new v2.Sandbox* events + bridging materializers" (Issue 2)

### User stories addressed

- User story 4
- User story 20

---

## Issue 9: DockerSandboxProvider — wrap existing ContainerService behind SandboxProvider

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Create a `DockerSandboxProvider` that implements the `SandboxProvider` interface by delegating to the existing `ContainerService`, `DepsImageService`, and `DockerDetection` services.

This is a thin adapter layer:
- `createSandbox` -> calls `DepsImageService.ensureDepsImage` + `ContainerService.createContainer`, emits `v2.SandboxStarted` with `sandboxProvider: "docker"`
- `destroySandbox` -> calls `ContainerService.destroyContainer`, emits `v2.SandboxStopped`
- `pauseSandbox` -> calls `ContainerService.pauseContainer`, emits `v2.SandboxPaused`
- `resumeSandbox` -> calls `ContainerService.unpauseContainer`, emits `v2.SandboxResumed`
- `getPreviewUrl` -> constructs the `.orb.local` URL from the workspace's `sandboxUrl` + port
- `spawnTerminal` -> delegates to the existing `docker exec` flow, returns a `TerminalHandle`
- `reconcileState` -> delegates to existing startup reconciliation + docker events listener
- `checkAvailability` -> delegates to `DockerDetection.check()`

The existing `ContainerService` internals do not change. This is purely a wrapper that bridges the old API to the new interface.

TDD approach: Write a test that creates a `DockerSandboxProvider` from its layer, calls `checkAvailability`, and verifies it delegates to `DockerDetection`. This is the tracer bullet. Then add tests for the other methods. These are integration tests requiring Docker — tag them accordingly.

### Acceptance criteria

- [ ] `DockerSandboxProvider` implements `SandboxProvider` interface
- [ ] All 8 interface methods delegate correctly to existing services
- [ ] Emits `v2.Sandbox*` events (not old `v1.Container*` events) for new operations
- [ ] `DockerSandboxProvider.layer` depends on `ContainerService.layer`, `DepsImageService.layer`, `DockerDetection.layer`
- [ ] Existing Docker behavior unchanged — this is a pure adapter
- [ ] Integration tests (tagged as Docker-required) verify delegation
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "SandboxProvider Effect interface definition" (Issue 8)

### User stories addressed

- User story 20

---

## Issue 10: WorkspaceProvider refactor — delegate to SandboxProvider instead of ContainerService

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Refactor `WorkspaceProvider` to depend on `SandboxProvider` instead of directly depending on `ContainerService` + `DepsImageService` + `DockerDetection`.

Changes:
- Replace `ContainerService`, `DepsImageService`, `DockerDetection` in the layer dependencies with `SandboxProvider`
- `performContainerSetup` becomes `performSandboxSetup` and delegates to `SandboxProvider.createSandbox`
- Container destroy calls in `destroyWorktree` delegate to `SandboxProvider.destroySandbox`
- The `startContainer` method becomes `startSandbox` and delegates to `SandboxProvider.createSandbox`
- Provider resolution: read the effective provider from `ConfigService.resolveConfig` to determine which `SandboxProvider` implementation to use

At this point, only `DockerSandboxProvider` exists as an implementation, so the refactor is purely structural — behavior doesn't change.

TDD approach: Write a test that creates a workspace via `WorkspaceProvider` with the Docker provider and verifies the sandbox is created (i.e., the existing Docker flow still works through the new abstraction). This is a high-value integration test.

### Acceptance criteria

- [ ] `WorkspaceProvider.layer` depends on `SandboxProvider` instead of `ContainerService` + `DepsImageService` + `DockerDetection`
- [ ] `performContainerSetup` renamed to `performSandboxSetup`, delegates to `SandboxProvider.createSandbox`
- [ ] `destroyWorktree` delegates sandbox cleanup to `SandboxProvider.destroySandbox`
- [ ] `startContainer` renamed to `startSandbox`, delegates to `SandboxProvider.createSandbox`
- [ ] Docker flow continues to work unchanged through the new abstraction
- [ ] Integration test verifies end-to-end workspace creation with Docker provider
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DockerSandboxProvider — wrap existing ContainerService behind SandboxProvider" (Issue 9)

### User stories addressed

- User story 4

---

## Issue 11: Daytona SDK client Effect service (thin wrapper)

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Create a `DaytonaClient` Effect service in `packages/server/src/services/daytona-client.ts` that wraps the `@daytonaio/sdk` `Daytona` class as an Effect Context.Tag.

Install `@daytonaio/sdk` as a dependency of `packages/server`.

The service:
- Reads `DAYTONA_API_KEY`, `DAYTONA_API_URL`, `DAYTONA_TARGET` from the env service
- Constructs a `Daytona` instance on layer creation
- Exposes the `Daytona` instance methods as Effect-wrapped operations:
  - `create(params)` -> `Effect<Sandbox, RpcError>`
  - `get(id)` -> `Effect<Sandbox, RpcError>`
  - `list(labels?)` -> `Effect<PaginatedSandboxes, RpcError>`
  - `start(sandbox)` -> `Effect<void, RpcError>`
  - `stop(sandbox)` -> `Effect<void, RpcError>`
  - `delete(sandbox)` -> `Effect<void, RpcError>`
  - `snapshot` -> expose snapshot sub-service

Each method wraps the Promise-based SDK call in `Effect.tryPromise` with proper error mapping to `RpcError`.

TDD approach: Write a test that constructs the `DaytonaClient` layer with test credentials and verifies the layer constructs without error. For integration tests (requiring real API key), write a test that calls `list()` and verifies it returns a result. Tag these as Daytona-required.

### Acceptance criteria

- [ ] `@daytonaio/sdk` installed as dependency of `packages/server`
- [ ] `DaytonaClient` Effect Context.Tag defined
- [ ] Layer reads env vars and constructs `Daytona` instance
- [ ] All key SDK methods wrapped as Effect operations
- [ ] Error mapping: SDK errors -> `RpcError` with descriptive codes
- [ ] `DaytonaError`, `DaytonaNotFoundError`, `DaytonaRateLimitError`, `DaytonaTimeoutError` mapped to distinct RPC error codes
- [ ] Integration test (Daytona API key required) verifies basic SDK connectivity
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Daytona env vars in packages/env" (Issue 7)

### User stories addressed

- User story 1

---

## Issue 12: Daytona availability check service + RPC

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Create a Daytona-specific availability check that verifies the API key is present and the Daytona API is reachable. This parallels the existing `DockerDetection` service.

The check:
1. Verify `DAYTONA_API_KEY` is set in env vars
2. Call `daytona.list({ limit: 1 })` as a lightweight connectivity test
3. Return `{ available: boolean, error?: string }`

Expose this through the `sandbox.providerStatus` RPC (defined in Issue 3). The RPC should return status for the currently-configured provider (Docker or Daytona based on the global default).

On the UI side, if the configured provider is Daytona and it's unavailable, show a warning banner similar to the Docker unavailable banner but with Daytona-specific guidance (check API key, check network).

TDD approach: Write a test that calls the availability check with a missing API key and verifies it returns `{ available: false, error: "..." }`. Then write a test with a valid key (integration test, Daytona-required).

### Acceptance criteria

- [ ] Daytona availability check verifies API key + API connectivity
- [ ] Returns `{ available: boolean, error?: string }` matching the Docker check shape
- [ ] `sandbox.providerStatus` RPC returns status for the configured provider
- [ ] UI shows Daytona-specific warning banner when unavailable
- [ ] Banner includes guidance: "Check your DAYTONA_API_KEY" / "API unreachable"
- [ ] Unit test: missing API key returns unavailable
- [ ] Integration test (Daytona-required): valid key returns available
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Daytona SDK client Effect service" (Issue 11)

### User stories addressed

- User story 15

---

## Issue 13: DaytonaSandboxProvider — create sandbox

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Implement the `createSandbox` method of `DaytonaSandboxProvider`. This is the core of the Daytona integration — creating a cloud sandbox for a workspace.

Steps:
1. Determine the image: use `devServer.image` from config, or fall back to the default Daytona image (no image param = Daytona default)
2. Call `daytonaClient.create()` with:
   - `image` or `snapshot` based on config
   - `language: "typescript"` (for Node.js projects)
   - `envVars` from workspace env
   - `autoStopInterval` from config (default 15 minutes)
   - `resources` from config if specified
   - `labels: { "laborer-workspace-id": workspaceId, "laborer-project": projectName }`
3. Wait for the sandbox to reach `started` state
4. Commit `v2.SandboxStarted` event to LiveStore with sandbox ID, URL, image, and `sandboxProvider: "daytona"`

The `DaytonaSandboxProvider` is a new file `packages/server/src/services/daytona-sandbox-provider.ts` that implements `SandboxProvider`.

TDD approach: Write an integration test (Daytona API key required) that creates a sandbox, verifies it reaches `started` state, then deletes it. This is the tracer bullet for the entire Daytona integration. For unit tests, mock the `DaytonaClient` and verify the correct parameters are passed.

### Acceptance criteria

- [ ] `DaytonaSandboxProvider` implements `SandboxProvider.createSandbox`
- [ ] Sandbox created via `DaytonaClient.create()` with correct parameters
- [ ] Labels include `laborer-workspace-id` and `laborer-project` for traceability
- [ ] `autoStopInterval` configurable, defaults to 15 minutes
- [ ] `resources` passed through from config when specified
- [ ] `v2.SandboxStarted` event committed with `sandboxProvider: "daytona"`
- [ ] Setup step progress communicated via `v2.SandboxSetupStepChanged` events
- [ ] Integration test: create sandbox, verify state, delete (Daytona-required)
- [ ] Unit test: verify correct SDK parameters with mocked client
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "SandboxProvider Effect interface definition" (Issue 8)
- Blocked by "Daytona SDK client Effect service" (Issue 11)

### User stories addressed

- User story 1
- User story 4

---

## Issue 14: DaytonaSandboxProvider — destroy sandbox

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Implement the `destroySandbox` method of `DaytonaSandboxProvider`.

Steps:
1. Look up the workspace in LiveStore to get the `sandboxId`
2. If no sandbox exists, log and return gracefully (idempotent)
3. Call `daytonaClient.delete(sandbox)` to destroy the cloud sandbox
4. Clean up any SSH config entries for this workspace (see Issue 22, but prepare the hook here)
5. Commit `v2.SandboxStopped` event to LiveStore

Error handling: If the sandbox is already destroyed or not found (Daytona returns 404), treat as success and still commit `v2.SandboxStopped`. Log warnings for other errors but don't fail the destroy.

TDD approach: Write a unit test with a mocked DaytonaClient that verifies `destroySandbox` calls `delete` and commits the right event. Write an integration test (Daytona-required) that creates then destroys a sandbox.

### Acceptance criteria

- [ ] `DaytonaSandboxProvider.destroySandbox` implemented
- [ ] Looks up `sandboxId` from LiveStore workspace row
- [ ] Calls `DaytonaClient.delete()` to destroy the sandbox
- [ ] Commits `v2.SandboxStopped` event to LiveStore
- [ ] Idempotent: gracefully handles already-destroyed sandboxes
- [ ] Best-effort: logs warnings on errors but doesn't fail the destroy
- [ ] Unit test with mocked client
- [ ] Integration test (Daytona-required)
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)

### User stories addressed

- User story 18

---

## Issue 15: Git sync — push worktree HEAD to Daytona sandbox via SSH

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

After a Daytona sandbox is created (Issue 13), push the local worktree's current HEAD to the sandbox so it has the project code.

Steps:
1. Get SSH access: `sandbox.createSshAccess(10)` — returns a token and constructs an SSH URL
2. Ensure the sandbox has a git repo: `sandbox.process.executeCommand('git init /home/daytona/project')`
3. Add a git remote in the local worktree: `git remote add sandbox-{workspaceId} ssh://{token}@ssh.app.daytona.io/home/daytona/project`
4. Push: `git push sandbox-{workspaceId} HEAD:main --force`
5. Inside the sandbox: `sandbox.process.executeCommand('cd /home/daytona/project && git checkout main')`
6. Clean up the local remote: `git remote remove sandbox-{workspaceId}`

This is called as part of `DaytonaSandboxProvider.createSandbox` after the sandbox reaches `started` state. Report progress via `v2.SandboxSetupStepChanged({ step: 'pushing-code' })`.

TDD approach: Write unit tests for the SSH URL construction and git command building (pure functions). Write an integration test (Daytona-required) that pushes a test repo to a sandbox and verifies the files exist via `sandbox.fs.listFiles()`.

### Acceptance criteria

- [ ] SSH access obtained via `sandbox.createSshAccess()`
- [ ] Git repo initialized in sandbox if not present
- [ ] Local worktree HEAD pushed to sandbox via SSH git remote
- [ ] Sandbox checks out the pushed code
- [ ] Local git remote cleaned up after push
- [ ] Progress reported via `v2.SandboxSetupStepChanged({ step: 'pushing-code' })`
- [ ] Unit tests for SSH URL construction and git command building
- [ ] Integration test: push code, verify files exist in sandbox (Daytona-required)
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)

### User stories addressed

- User story 11
- User story 12

---

## Issue 16: Daytona PTY — WebSocket session creation + sendInput/resize

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Implement the `spawnTerminal` method of `DaytonaSandboxProvider`. This creates a Daytona PTY session over WebSocket that can be used for interactive terminal access to the sandbox.

Steps:
1. Call `sandbox.process.createPty({ id: sessionId, cwd: '/home/daytona/project', cols, rows, onData })` where `onData` receives raw terminal output as `Uint8Array`
2. Return a `TerminalHandle` that wraps the `PtyHandle`:
   - `sendInput(data: string | Uint8Array)` -> `ptyHandle.sendInput(data)`
   - `resize(cols: number, rows: number)` -> `ptyHandle.resize(cols, rows)`
   - `kill()` -> `ptyHandle.kill()`
   - `onData` callback for output

The `TerminalHandle` shape must match what the existing terminal infrastructure expects, so that both Docker terminals (via `docker exec` PTY) and Daytona terminals (via WebSocket PTY) appear the same to the rest of the system.

TDD approach: Write an integration test (Daytona-required) that creates a PTY session, sends `echo hello\n`, and verifies the output contains `hello`. This is the tracer bullet for terminal connectivity.

### Acceptance criteria

- [ ] `DaytonaSandboxProvider.spawnTerminal` implemented
- [ ] Creates a Daytona PTY session via `sandbox.process.createPty()`
- [ ] Returns a `TerminalHandle` with `sendInput`, `resize`, `kill`, `onData`
- [ ] PTY session connects over WebSocket with proper authentication
- [ ] `lazyStart: true` used so PTY starts on first connection
- [ ] Integration test: send command, verify output (Daytona-required)
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)

### User stories addressed

- User story 8

---

## Issue 17: Daytona PTY — bridge to xterm.js terminal component

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Bridge the Daytona PTY `TerminalHandle` (from Issue 16) to the existing xterm.js terminal component in the web UI.

Currently, the terminal component connects to Docker-based terminals via the terminal utility process's MessagePort RPC. For Daytona terminals, the data flow is different:
- Output: `ptyHandle.onData(Uint8Array)` -> `xterm.Terminal.write(data)`
- Input: `xterm.onData(string)` -> `ptyHandle.sendInput(data)`
- Resize: `xterm.onResize({cols, rows})` -> `ptyHandle.resize(cols, rows)`

The `TerminalClient` service needs to be extended to support both flows. When a workspace uses Daytona, terminal spawn requests should create a Daytona PTY handle instead of sending an RPC to the terminal utility process.

The web terminal component should be agnostic — it receives data and sends input through the same interface regardless of provider. The provider-specific wiring happens in the service layer.

TDD approach: Write a test that verifies the terminal component can attach to a `TerminalHandle` and round-trip data. Use a mock `TerminalHandle` for the unit test.

### Acceptance criteria

- [ ] `TerminalClient` extended to support Daytona terminal handles alongside Docker terminals
- [ ] Terminal component's data flow works with both Docker and Daytona handles
- [ ] Output from Daytona PTY pipes to xterm.Terminal.write()
- [ ] Input from xterm.onData pipes to TerminalHandle.sendInput()
- [ ] Resize events pipe to TerminalHandle.resize()
- [ ] Unit test with mock TerminalHandle verifies round-trip data flow
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "Daytona PTY — WebSocket session creation + sendInput/resize" (Issue 16)

### User stories addressed

- User story 8

---

## Issue 18: Daytona preview URLs — getPreviewUrl + UI display

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Implement the `getPreviewUrl` method of `DaytonaSandboxProvider` and update the UI to display Daytona preview URLs.

Implementation:
1. `getPreviewUrl(workspaceId, port)` calls `sandbox.getPreviewLink(port)` via the SDK
2. Returns the URL string from the `PortPreviewUrl.url` field
3. Store the preview URL in the `sandboxUrl` column (may differ from the sandbox's base URL)

UI update:
- The workspace frame header already displays `sandboxUrl` as a clickable link (after Issue 4's rename)
- For Daytona, the URL format is `https://{port}-{sandboxId}.preview.daytona.io` instead of `.orb.local`
- The copy button and click behavior should work the same regardless of URL format
- If the port changes (user configures a different dev server port), refresh the preview URL

TDD approach: Write a unit test with a mocked DaytonaClient that verifies `getPreviewUrl` returns the URL from the SDK. Write a UI test that verifies a Daytona-format URL renders correctly in the workspace header.

### Acceptance criteria

- [ ] `DaytonaSandboxProvider.getPreviewUrl` implemented
- [ ] Calls `sandbox.getPreviewLink(port)` and returns the URL
- [ ] Preview URL stored in `sandboxUrl` column
- [ ] UI displays Daytona preview URLs with same visual treatment as `.orb.local` URLs
- [ ] Copy button works for Daytona URLs
- [ ] Unit test with mocked client
- [ ] UI test for Daytona URL display
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)

### User stories addressed

- User story 7

---

## Issue 19: Daytona sandbox pause/resume (stop/start) + auto-stop config

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Implement the `pauseSandbox` and `resumeSandbox` methods of `DaytonaSandboxProvider`.

**Pause** (maps to Daytona `stop`):
1. Look up sandbox from LiveStore
2. Call `sandbox.stop()` via the SDK
3. Commit `v2.SandboxPaused` event to LiveStore

**Resume** (maps to Daytona `start`):
1. Look up sandbox from LiveStore
2. Call `sandbox.start()` via the SDK (~1-2s)
3. Commit `v2.SandboxResumed` event to LiveStore

Both methods should be idempotent: pausing an already-stopped sandbox or resuming an already-started sandbox returns gracefully.

Auto-stop is configured at sandbox creation time (Issue 13) via `autoStopInterval`. This issue also adds the ability to update it after creation via `sandbox.setAutostopInterval()`, exposed through the `sandbox.setAutoStop` RPC.

TDD approach: Write a unit test that verifies `pauseSandbox` calls `sandbox.stop()` and commits `SandboxPaused`. Write an integration test (Daytona-required) that creates a sandbox, pauses it, resumes it, and verifies the state transitions.

### Acceptance criteria

- [ ] `DaytonaSandboxProvider.pauseSandbox` calls `sandbox.stop()` and commits `v2.SandboxPaused`
- [ ] `DaytonaSandboxProvider.resumeSandbox` calls `sandbox.start()` and commits `v2.SandboxResumed`
- [ ] Both methods idempotent (no error if already in target state)
- [ ] Auto-stop interval set at creation time, updatable after creation
- [ ] New RPC `sandbox.setAutoStop` to update interval
- [ ] Unit tests with mocked client
- [ ] Integration test: create, pause, resume, verify state (Daytona-required)
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)

### User stories addressed

- User story 9
- User story 10

---

## Issue 20: Daytona state reconciliation polling loop

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Implement the `reconcileState` method of `DaytonaSandboxProvider` as a polling loop that syncs LiveStore with actual Daytona sandbox states.

Unlike Docker (which uses a `docker events` real-time stream), Daytona has no event stream. The reconciliation runs as a daemon fiber that polls every 30 seconds:

1. Query LiveStore for all workspaces with `sandboxProvider === "daytona"` and a non-null `sandboxId`
2. For each, call `daytonaClient.get(sandboxId)` to check actual state
3. Compare actual state to LiveStore state:
   - Daytona `stopped` + LiveStore `running` -> commit `v2.SandboxPaused`
   - Daytona `started` + LiveStore `paused` -> commit `v2.SandboxResumed`
   - Daytona `destroyed`/not found + LiveStore any -> commit `v2.SandboxStopped`
   - Daytona `archived` + LiveStore any -> commit `v2.SandboxPaused` (treat archived as paused)
4. Handle errors gracefully: if a single sandbox check fails, log warning and continue with others

The polling loop starts as a daemon fiber during service initialization (similar to how `ContainerService` starts the `docker events` listener).

On startup (before the polling loop begins), run one immediate reconciliation pass to catch changes that happened while the app was closed.

TDD approach: Write a unit test with a mocked DaytonaClient that returns a `stopped` sandbox and verifies the reconciliation commits `SandboxPaused`. Then test the `destroyed` case. Then test the already-in-sync case (no event committed).

### Acceptance criteria

- [ ] `DaytonaSandboxProvider.reconcileState` implemented as a polling loop
- [ ] Polls every 30 seconds via a daemon fiber
- [ ] One immediate reconciliation pass on startup
- [ ] Correct state transitions: stopped->paused, started->resumed, destroyed->stopped
- [ ] Handles archived sandboxes (treated as paused)
- [ ] Errors on individual sandbox checks don't block others
- [ ] Daemon fiber cleaned up on service shutdown (addFinalizer)
- [ ] Unit tests with mocked client for each state transition
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)
- Blocked by "Daytona sandbox pause/resume" (Issue 19)

### User stories addressed

- User story 25

---

## Issue 21: Daytona Image builder — snapshot caching with lockfile hash

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Implement dependency caching for Daytona sandboxes using the Image builder and snapshot system. This mirrors the `DepsImageService` pattern but uses Daytona's infrastructure.

Steps:
1. Detect the project's lockfile (bun.lock, package-lock.json, yarn.lock, pnpm-lock.yaml)
2. Hash the lockfile contents with SHA-256
3. Generate a snapshot name: `laborer-{projectSlug}-{lockfileHash}` (truncated to fit Daytona's name limits)
4. Check if a snapshot with that name exists: `daytona.snapshot.get(snapshotName)`
5. If it exists, create the sandbox from the snapshot: `daytona.create({ snapshot: snapshotName })`
6. If it doesn't exist:
   a. Build an Image using Daytona's Image builder: start from `devServer.image` or default, add `runCommands(installCommand)`
   b. Create the snapshot: `daytona.snapshot.create({ name: snapshotName, image })`
   c. Stream build logs to the UI via `onSnapshotCreateLogs` callback and `v2.SandboxSetupStepChanged` events
   d. Create the sandbox from the new snapshot

This is called from `DaytonaSandboxProvider.createSandbox` when `devServer.installCommand` is configured.

TDD approach: Write unit tests for lockfile detection (which lockfile, hashing), snapshot name generation (pure functions). Write an integration test (Daytona-required) that builds a snapshot from a Node.js image with `npm install` and verifies it's cached for subsequent creates.

### Acceptance criteria

- [ ] Lockfile detection: bun.lock, package-lock.json, yarn.lock, pnpm-lock.yaml
- [ ] SHA-256 hash of lockfile used as cache key
- [ ] Snapshot name format: `laborer-{projectSlug}-{lockfileHash}`
- [ ] Existing snapshot reused when lockfile hash matches
- [ ] New snapshot built via Image builder when cache misses
- [ ] Build logs streamed to UI via setup step events
- [ ] `devServer.installCommand` used as the install step in the image
- [ ] Unit tests for lockfile detection and snapshot name generation
- [ ] Integration test: build snapshot, reuse on second create (Daytona-required)
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)

### User stories addressed

- User story 16
- User story 17
- User story 22
- User story 23

---

## Issue 22: VS Code Remote SSH — SSH config automation + token refresh

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Automate VS Code Remote SSH configuration for Daytona sandboxes by managing `~/.ssh/config` entries.

When a Daytona sandbox is created or resumed:
1. Call `sandbox.createSshAccess(60)` to get a 60-minute token
2. Write/update an entry in `~/.ssh/config`:
   ```
   # laborer-managed: {workspaceId}
   Host laborer-{workspaceId}
     HostName ssh.app.daytona.io
     Port 2222
     User {token}
     StrictHostKeyChecking no
     UserKnownHostsFile /dev/null
   ```
3. Start a background fiber that refreshes the token at the 45-minute mark: call `createSshAccess(60)` again and update the `User` field in the config

When a sandbox is paused or destroyed:
1. Remove the SSH config entry (identified by the `# laborer-managed` comment)
2. Cancel the refresh fiber

Expose an "Open in VS Code" action in the workspace UI that runs: `code --remote ssh-remote+laborer-{workspaceId} /home/daytona/project`

TDD approach: Write unit tests for SSH config entry generation, parsing, insertion, and removal (pure string operations on config file content). Write a test that verifies entries are correctly identified by the `# laborer-managed` marker. Integration tests for the full flow require a real Daytona sandbox.

### Acceptance criteria

- [ ] SSH config entries written to `~/.ssh/config` on sandbox create/resume
- [ ] Entries use `# laborer-managed: {workspaceId}` comment for identification
- [ ] Token refresh fiber runs at 45-minute intervals
- [ ] Entries removed on sandbox pause/destroy
- [ ] No stale entries accumulate (cleanup on destroy)
- [ ] "Open in VS Code" UI action runs `code --remote ssh-remote+...`
- [ ] Handles edge cases: existing SSH config with custom entries, multiple managed entries
- [ ] Unit tests for SSH config generation, parsing, insertion, removal
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)

### User stories addressed

- User story 13
- User story 14

---

## Issue 23: End-to-end integration — Daytona workspace creation flow

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Wire together all previous Daytona issues into the complete workspace creation flow through `WorkspaceProvider`:

1. User creates a workspace for a project with `provider: "daytona"` in config
2. `WorkspaceProvider.createWorktree` creates the local git worktree (existing behavior)
3. `WorkspaceProvider.performSandboxSetup` detects the Daytona provider and delegates to `DaytonaSandboxProvider`
4. `DaytonaSandboxProvider.createSandbox`:
   a. Checks for cached snapshot (Issue 21) — uses it if available
   b. Creates the Daytona sandbox
   c. Pushes worktree HEAD via SSH git (Issue 15)
   d. Sets up SSH config for VS Code (Issue 22)
5. Terminal spawning uses Daytona PTY (Issues 16, 17)
6. Preview URL obtained and stored (Issue 18)
7. Setup step progress communicated throughout (Issue 24)

This issue is about verifying the full flow works end-to-end and fixing any integration gaps between the individual pieces. It should also verify that the Docker flow is completely unaffected.

TDD approach: Write an integration test (Daytona API key required) that creates a full workspace with the Daytona provider, verifies the sandbox is running with code pushed, gets a preview URL, spawns a terminal, then destroys it cleanly.

### Acceptance criteria

- [ ] Full workspace creation flow works with Daytona provider
- [ ] Worktree created locally
- [ ] Daytona sandbox created with correct parameters
- [ ] Code pushed to sandbox via SSH git
- [ ] Terminal spawnable in sandbox
- [ ] Preview URL obtainable
- [ ] Workspace destroy cleans up sandbox + SSH config + worktree
- [ ] Docker flow completely unaffected (regression test)
- [ ] Integration test: full Daytona workspace lifecycle (Daytona-required)
- [ ] Integration test: Docker workspace lifecycle still works (Docker-required)
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "WorkspaceProvider refactor — delegate to SandboxProvider" (Issue 10)
- Blocked by "DaytonaSandboxProvider — create sandbox" (Issue 13)
- Blocked by "Git sync — push worktree HEAD to Daytona sandbox via SSH" (Issue 15)
- Blocked by "Daytona PTY — WebSocket session creation + sendInput/resize" (Issue 16)

### User stories addressed

- User story 4
- User story 5
- User story 6
- User story 21

---

## Issue 24: Setup step progress UI for Daytona-specific steps

### Parent PRD

PRD-daytona-sandbox-provider.md

### What to build

Update the workspace creation progress UI to display Daytona-specific setup steps. The current UI shows Docker steps like "building-image" and "starting-container". For Daytona, the steps are different:

- `creating-sandbox` — Daytona SDK create call in progress
- `building-snapshot` — Building a new snapshot from Image builder (cache miss)
- `pushing-code` — Pushing worktree HEAD to sandbox via SSH git
- `configuring-ssh` — Writing SSH config for VS Code
- `starting-sandbox` — Sandbox transitioning to started state

Each step is communicated via `v2.SandboxSetupStepChanged` events (already defined in Issue 2). The UI reads the `sandboxSetupStep` column and displays a human-readable label with a spinner.

The UI should render these labels without provider-specific conditional logic — both Docker and Daytona steps map through the same `sandboxSetupStep` column. Add a mapping from step key to display label that covers both provider's steps.

TDD approach: Write a UI test that sets `sandboxSetupStep` to `"pushing-code"` and verifies the component renders the correct human-readable label.

### Acceptance criteria

- [ ] Step-to-label mapping covers all Daytona steps: `creating-sandbox`, `building-snapshot`, `pushing-code`, `configuring-ssh`, `starting-sandbox`
- [ ] Mapping also covers existing Docker steps: `building-image`, `starting-container`
- [ ] UI renders human-readable labels with spinner for each step
- [ ] No provider-specific conditional logic in the UI — same component handles both providers
- [ ] `sandboxSetupStep: null` clears the progress indicator (setup complete)
- [ ] UI test for each Daytona-specific step label
- [ ] Type checks pass
- [ ] `bun run format` passes

### Blocked by

- Blocked by "End-to-end integration — Daytona workspace creation flow" (Issue 23)

### User stories addressed

- User story 21

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 1 | Schema rename: container* columns to sandbox* | None | Done |
| 2 | Schema: new v2.Sandbox* events + bridging materializers | 1 | Done |
| 3 | RPC rename: container.* to sandbox.* with backward-compat aliases | 2 | Done |
| 4 | UI: update all components to use sandbox* column names + RPC names | 3 | Done |
| 5 | Provider config: add provider field to laborer.json + config resolution | 1 | Done |
| 6 | Provider config: global default sandbox provider in appSettings | 5 | Ready |
| 7 | Daytona env vars in packages/env | None | Done |
| 8 | SandboxProvider Effect interface definition | 2 | Done |
| 9 | DockerSandboxProvider: wrap existing ContainerService behind SandboxProvider | 8 | Done |
| 10 | WorkspaceProvider refactor: delegate to SandboxProvider instead of ContainerService | 9 | Done |
| 11 | Daytona SDK client Effect service (thin wrapper) | 7 | Done |
| 12 | Daytona availability check service + RPC | 11 | Done |
| 13 | DaytonaSandboxProvider: create sandbox | 8, 11 | Done |
| 14 | DaytonaSandboxProvider: destroy sandbox | 13 | Done |
| 15 | Git sync: push worktree HEAD to Daytona sandbox via SSH | 13 | Done |
| 16 | Daytona PTY: WebSocket session creation + sendInput/resize | 13 | Done |
| 17 | Daytona PTY: bridge to xterm.js terminal component | 16 | Done |
| 18 | Daytona preview URLs: getPreviewUrl + UI display | 13 | Done |
| 19 | Daytona sandbox pause/resume (stop/start) + auto-stop config | 13 | Done |
| 20 | Daytona state reconciliation polling loop | 13, 19 | Done |
| 21 | Daytona Image builder: snapshot caching with lockfile hash | 13 | Ready |
| 22 | VS Code Remote SSH: SSH config automation + token refresh | 13 | Ready |
| 23 | End-to-end integration: Daytona workspace creation flow | 10, 13, 15, 16 | Done |
| 24 | Setup step progress UI for Daytona-specific steps | 23 | Ready |

### Parallelization opportunities

These issues can be worked on simultaneously:
- **Issues 1 and 7** — schema rename and env vars are independent
- **Issues 5 and 8** — config changes and interface definition are independent (both depend on 1)
- **Issues 9 and 11** — Docker adapter and Daytona SDK client are independent (9 depends on 8, 11 depends on 7)
- **Issues 14, 15, 16, 18, 19, 21, 22** — all depend only on 13 and can be worked in parallel once 13 is done
