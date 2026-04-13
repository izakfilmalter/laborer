# Issues: Shuru Sandbox Provider

## Issue 1: Surface `shuru` as a selectable provider with real availability gating

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Add `shuru` to Laborer's provider-facing config and settings surface so users can select it per project or as the global default provider.

This slice must remain end-to-end, not just schema-only. A user should be able to:

1. See `shuru` in provider selection UI.
2. Choose it in project config and global default settings.
3. See it disabled with a concrete reason when the machine is unsupported or `shuru` is not installed.

This slice should not create real Shuru sandboxes yet. It establishes the first user-visible tracer bullet for the provider and ensures the product can surface `shuru` honestly before lifecycle work lands.

TDD approach: Start with one behavior test that resolves a project configured with `devServer.provider = 'shuru'` and verifies the setting survives the full config/RPC round trip. Then add one UI-facing test that verifies `shuru` appears disabled with an explanatory message when availability checks fail. Implement only enough wiring to satisfy those behaviors before adding broader cases.

### Acceptance criteria

- [x] `shuru` is accepted anywhere the app currently accepts `docker` or `daytona` as a sandbox provider value
- [x] Global default provider settings can store and return `shuru`
- [x] Availability checks can distinguish supported+installed from unsupported/uninstalled Shuru environments
- [x] The UI shows `shuru` as an option even when unavailable
- [x] Unavailable `shuru` states are disabled and include a concrete reason
- [x] Provider selection tests cover both per-project and global-default cases
- [x] Type checks pass
- [x] Formatting passes

### Blocked by

None - can start immediately.

### User stories addressed

- User story 1
- User story 2
- User story 3

---

## Issue 2: Hello-world Shuru sandbox lifecycle through `SandboxProvider`

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Implement the narrowest real Shuru lifecycle slice that proves Laborer can boot and destroy a local Shuru-backed sandbox through the existing provider abstraction.

This slice should include:

1. A deep module for driving `shuru run --stdio` from the server process.
2. A `ShuruSandboxProvider` that can create and destroy a mounted Shuru VM.
3. Router integration so a workspace configured with `provider = 'shuru'` reaches this implementation.
4. LiveStore updates that mark the workspace as having a running/stopped sandbox through the existing `sandbox*` fields.

Keep the behavior narrow: create a VM from the local worktree mount, record sandbox state, then tear it down cleanly. Do not broaden into preview URLs, pause/resume, or dev-server streaming yet.

TDD approach: Write one provider-level integration test that creates a Shuru-backed sandbox for a workspace and verifies the public `SandboxProvider` contract reports it as created and then destroyed. Use a fake `shuru --stdio` process instead of asserting child-process internals. Once that tracer bullet passes, add smaller tests for error mapping and cleanup.

### Acceptance criteria

- [x] A Shuru client module can spawn and speak to `shuru run --stdio`
- [x] `ShuruSandboxProvider` implements `createSandbox` and `destroySandbox`
- [x] The provider mounts the local worktree into `/workspace` using read-only Shuru mounts
- [x] `SandboxProviderRouter` can route `provider = 'shuru'` workspaces to the Shuru provider
- [x] Creating a Shuru sandbox records provider-appropriate `sandboxId`, `sandboxStatus`, and provider metadata in LiveStore
- [x] Destroying a Shuru sandbox clears sandbox runtime state cleanly
- [x] Provider behavior is tested through public service interfaces
- [x] Type checks pass
- [x] Formatting passes

### Blocked by

None - completed.

### User stories addressed

- User story 4
- User story 5
- User story 13

---

## Issue 3: Localhost previews with automatic host-port allocation

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Extend the Shuru provider so a configured guest dev-server port becomes a usable localhost preview URL without collisions between workspaces.

This slice should:

1. Auto-allocate an available host port per Shuru workspace.
2. Forward that host port to the configured guest port.
3. Persist preview metadata into the existing `sandboxUrl` / `sandboxPort` fields.
4. Make existing preview-link UI render a valid localhost URL.

This must work even when multiple workspaces all expose the same guest port like `3000`.

TDD approach: Start with one provider test that creates two Shuru workspaces configured for the same guest port and verifies `getPreviewUrl()` returns two distinct localhost URLs. Then add one UI-level test that verifies the preview link is rendered and clickable using the existing sandbox preview path.

### Acceptance criteria

- [ ] Shuru sandbox creation allocates an available host port instead of assuming guest port reuse is possible
- [ ] Host port forwarding is established during sandbox setup
- [ ] `sandboxUrl` and `sandboxPort` reflect the localhost preview endpoint for Shuru workspaces
- [ ] `getPreviewUrl()` returns `http://127.0.0.1:<hostPort>` for Shuru workspaces
- [ ] Multiple Shuru workspaces can expose the same guest port without host-port collisions
- [ ] Existing preview-link UI works for Shuru localhost previews
- [ ] Tests cover both provider behavior and UI rendering
- [ ] Type checks pass
- [ ] Formatting passes

### Blocked by

None - Issue 2 is complete.

### User stories addressed

- User story 6

---

## Issue 4: Shuru dev-server session with host-terminal routing unchanged

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Add the first end-to-end Shuru dev-server execution path while preserving Laborer's existing host-terminal model.

This slice should make one thing true: when a workspace's dev server is started, the process runs inside the Shuru VM, but all normal workspace terminals still run on the host.

Because `shuru --stdio` is stream-backed rather than PTY-backed, the Shuru dev-server pane should be treated as a sandboxed process session:

1. Stream stdout/stderr into the existing terminal UI path.
2. Forward stdin when needed.
3. Support stop/kill.
4. Treat resize as a no-op.

TDD approach: Start with one routing test through `TerminalClient.spawnInWorkspace()` that proves an auto-run dev-server request on a Shuru workspace takes the Shuru path while a normal terminal request still takes the host path. Then add one behavior test that verifies streamed output from the sandboxed dev-server process reaches the UI-facing terminal abstraction.

### Acceptance criteria

- [ ] Auto-run dev-server sessions for Shuru workspaces execute inside the Shuru VM
- [ ] Regular manual terminals for Shuru workspaces continue to run on the host
- [ ] The Shuru dev-server session streams stdout/stderr through the terminal UI path
- [ ] Stdin forwarding and kill/stop are supported for the Shuru dev-server session
- [ ] Resize requests are handled safely as a no-op for Shuru-backed dev-server sessions
- [ ] Terminal-routing tests prove that only dev-server sessions use Shuru
- [ ] Type checks pass
- [ ] Formatting passes

### Blocked by

- Blocked by "Localhost previews with automatic host-port allocation" (Issue 3)

### User stories addressed

- User story 7
- User story 11
- User story 13

---

## Issue 5: Shared base checkpoint cache with automatic invalidation

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Implement the shared checkpoint layer that makes Shuru startup fast and deterministic across workspaces from the same project.

This slice should:

1. Compute a cache key from lockfile content and sandbox-relevant config.
2. Restore a matching base checkpoint when present.
3. Build the checkpoint when missing or stale.
4. Rebuild automatically when the cache inputs change.

This cache is specifically for shared dependency/setup state, not workspace pause/resume state.

TDD approach: Start with one cache-key behavior test that changes the lockfile hash and verifies the provider stops reusing the prior base checkpoint. Then add one higher-level provider test that proves two workspaces from the same unchanged project reuse the same base checkpoint.

### Acceptance criteria

- [ ] Shuru sandbox setup can restore from a shared base checkpoint when one matches current inputs
- [ ] Base checkpoint identity is derived from lockfile content and relevant sandbox config
- [ ] Base checkpoints rebuild automatically when cache inputs change
- [ ] Unchanged projects reuse the same base checkpoint across workspaces
- [ ] Progress/state reporting distinguishes checkpoint restore from checkpoint rebuild
- [ ] Tests cover both invalidation and reuse behavior
- [ ] Type checks pass
- [ ] Formatting passes

### Blocked by

None - Issue 2 is complete.

### User stories addressed

- User story 8
- User story 9

---

## Issue 6: Workspace pause/resume via runtime checkpoint restore

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Add the second checkpoint layer: a per-workspace runtime checkpoint used for pause/resume.

This slice should make pause/resume a real user feature for Shuru workspaces:

1. Pause checkpoints the live workspace runtime state and stops the VM.
2. Resume restores from that workspace checkpoint when available.
3. Resume falls back to the current shared base checkpoint when there is no workspace runtime checkpoint.
4. The workspace status and sandbox status remain honest throughout the transition.

TDD approach: Start with one provider-level test that pauses a Shuru workspace after mutating VM-private state, resumes it, and verifies the resumed sandbox comes back from the workspace runtime checkpoint rather than a fresh base restore. Then add the fallback case.

### Acceptance criteria

- [ ] `pauseSandbox()` creates a workspace runtime checkpoint and stops the VM
- [ ] `resumeSandbox()` restores from the workspace checkpoint when present
- [ ] `resumeSandbox()` falls back to the shared base checkpoint when no workspace checkpoint exists
- [ ] Sandbox status transitions correctly between `running` and `paused`
- [ ] VM-private state survives pause/resume as expected
- [ ] Tests cover both restore-from-runtime and fallback-to-base behavior
- [ ] Type checks pass
- [ ] Formatting passes

### Blocked by

- Blocked by "Shared base checkpoint cache with automatic invalidation" (Issue 5)

### User stories addressed

- User story 10
- User story 11

---

## Issue 7: Eager boot on workspace creation and retry/start flows

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Complete the workflow integration so `shuru` behaves like a real provider in workspace setup, not just a provider you can start manually later.

This slice should ensure:

1. Workspaces configured for `shuru` eagerly provision the sandbox during normal workspace creation.
2. Existing retry/start flows still work through `workspace.startSandbox`.
3. Workspace setup progress uses Shuru-specific setup steps.
4. Failure states leave the workspace recoverable rather than stuck.

TDD approach: Start with one RPC-level test that creates a new workspace resolved to `provider = 'shuru'` and verifies sandbox setup is forked as part of workspace creation rather than requiring a later manual start. Then add a retry-path test through `workspace.startSandbox`.

### Acceptance criteria

- [ ] Workspace creation eagerly starts Shuru sandbox setup when `provider = 'shuru'`
- [ ] `workspace.startSandbox` works for Shuru workspaces that need retry/manual start behavior
- [ ] Shuru-specific setup steps are emitted through existing sandbox setup progress mechanisms
- [ ] Failed Shuru setup clears progress state and leaves the workspace retryable
- [ ] RPC- and service-level tests cover both eager boot and retry flows
- [ ] Type checks pass
- [ ] Formatting passes

### Blocked by

- Blocked by "Shuru dev-server session with host-terminal routing unchanged" (Issue 4)
- Blocked by "Workspace pause/resume via runtime checkpoint restore" (Issue 6)

### User stories addressed

- User story 5
- User story 12
- User story 13

---

## Issue 8: Reconcile stale Shuru state and clean up failed sessions

### Parent PRD

PRD-shuru-sandbox-provider.md

### What to build

Finish the provider by making its local-process lifecycle honest across restarts, failures, and orphaned state.

This slice should:

1. Reconcile Shuru workspaces on startup.
2. Mark stale `running` Shuru sandboxes as no longer live when no runtime exists in the current session.
3. Preserve enough information for retry/resume flows to keep working.
4. Best-effort clean up orphaned child processes and stale runtime metadata.

This is the final reliability slice that makes the provider safe to use as a first-class local option.

TDD approach: Start with one reconciliation test that seeds LiveStore with a `running` Shuru workspace but no live runtime handle, then verifies startup reconciliation corrects the workspace state. Add one cleanup-path test for failed boot sessions afterward.

### Acceptance criteria

- [ ] Shuru provider participates in startup reconciliation
- [ ] Stale `running` Shuru workspaces are corrected when no live runtime exists in the current session
- [ ] Reconciliation leaves workspaces retryable or resumable rather than destroyed
- [ ] Failed or interrupted setup cleans up child-process/runtime metadata best-effort
- [ ] Reconciliation behavior is covered by public-interface tests
- [ ] Type checks pass
- [ ] Formatting passes

### Blocked by

- Blocked by "Eager boot on workspace creation and retry/start flows" (Issue 7)

### User stories addressed

- User story 12
- User story 13
