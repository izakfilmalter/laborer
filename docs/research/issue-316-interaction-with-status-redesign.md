# Issue #316 interaction with the legacy agent-status redesign

**Researched:** 2026-08-08  
**Repository:** `izakfilmalter/laborer`  
**Primary issue:** [#316](https://github.com/izakfilmalter/laborer/issues/316)

## Executive finding

Issue #316 has **no GitHub sub-issues or grandchildren** at the time of research. Both the GraphQL `subIssues(first: 50)` query and `GET /repos/izakfilmalter/laborer/issues/316/sub_issues` returned an empty list. GitHub's dependency endpoints also report no issues blocking or blocked by #316. The issue is one monolithic, open, `ready-for-agent` simplification ticket with no comments or linked closing PR.

The status/notification redesign and #316 are product-level complements: #316 narrows `apps/desktop/` to Projects, Workspaces, Terminals, and Diff Viewer, while the redesign repairs the status and notification behavior of the surviving terminal mission-control surface. They nevertheless have significant **file-level and hook-lifecycle overlap**. Most importantly, #316 deliberately deletes the `McpRegistrar` and its embedded OpenCode status plugin, explicitly saying that the plugin is discarded and “a different mechanism is planned.” The redesign is that replacement mechanism and must not be built inside or on top of `McpRegistrar`.

**Recommendation:** land all of #316 before implementing the redesign. If work must overlap, Phase 1 (MCP/plugin deletion) must land first; status implementation can then proceed in new modules, but shared RPC, Electron main/IPC, and workspace UI integration should wait for the remaining #316 phases to avoid editing files that #316 is simultaneously shrinking.

## Sources and method

- Issue body, metadata, labels, comments, and linked PRs: `gh issue view 316 --repo izakfilmalter/laborer --json ...`
- Tree: GitHub GraphQL `issue(number: 316) { subIssues { nodes { ... subIssues { ... } } } }` and REST `issues/316/sub_issues`
- Dependencies: REST `issues/316/dependencies/blocked_by` and `issues/316/dependencies/blocking`
- Tracker conventions: [`docs/agents/issue-tracker.md`](../agents/issue-tracker.md), especially lines 38–43 (maps use GitHub sub-issues; blocking uses native dependencies)
- Decided redesign: [`docs/adr/0005-agent-done-is-a-projection.md`](../adr/0005-agent-done-is-a-projection.md), [`docs/adr/0006-main-owned-notifications-process-scoped-hook-evidence.md`](../adr/0006-main-owned-notifications-process-scoped-hook-evidence.md), and [`CONTEXT.md`](../../CONTEXT.md#agent-status)
- Existing implementation surfaces under `apps/desktop/`, cited below

## Full issue tree

### Root: #316 — Remove brrr, plans, tasks, review feature, and the Laborer MCP from the legacy app (`apps/desktop/`)

- **State:** Open
- **Label:** `ready-for-agent`
- **Children:** None
- **Grandchildren:** None
- **Comments / linked closing PR / native dependencies:** None

**Concise summary:** Delete four unused legacy feature clusters—brrr, Plans/PRDs, Tasks, and the Laborer MCP—plus the brrr-only review-findings UI. Preserve historical LiveStore event decoding, terminal/workspace/PR/diff behavior, and simplify the app to Projects, Workspaces, Terminals, and Diff Viewer. Execute in six green phases: MCP; Review; Plans/Tasks; brrr; docs; verification.

Important requirements from the issue body:

1. **Surviving scope:** the solution leaves “a focused mission-control tool for Projects, Workspaces, Terminals, and the Diff Viewer.” User stories 8–10 require workspaces, terminals, and Diff Viewer to keep working unchanged.
2. **Status-plugin deletion:** the solution removes `McpRegistrar`, and says “the OpenCode agent-status hook plugin inside it is deliberately discarded; a different mechanism is planned.” Phase 1 repeats that the embedded plugin is deliberately discarded, while Out of Scope says replacing it is separate work.
3. **Electron/IPC changes:** Phase 1 removes the `mcp` sidecar from “the desktop utility-process manager, lifecycle/fork list, IPC validations, dev watcher, utility-process message types, the shared sidecar-name union, and the web sidecar-status UI.”
4. **RPC changes:** Phases 2–4 remove `review.*`, `prd.*`, `task.*`, and `brrr.*` contracts and handlers. User story 20 specifically preserves generic `terminal.spawn` coverage.
5. **Workspace UI changes:** Phases 2–3 remove review panes, plan views, task sections, task counts, and plan-branch scoping from panel/layout/sidebar/workspace/dashboard surfaces.
6. **No status replacement in #316:** its Out of Scope explicitly excludes replacement of the OpenCode status plugin. Thus #316 creates a clean boundary but does not implement any part of the new state machine or coordinator.

There are no child tickets to summarize or classify individually. The six phases are sections within #316, not GitHub child issues.

## Overlap analysis

| Surface | Relationship | Evidence and consequence |
|---|---|---|
| Terminal service / `terminal-manager.ts` | **Complement; no planned deletion, but same surviving subsystem** | #316 says terminals must keep spawn, adoption, restoration, and detached operation unchanged. It does not name `packages/terminal/src/services/terminal-manager.ts` for deletion. The redesign necessarily changes its current two-state `AgentStatus`, hook override map, ps arbitration, seen bit, provenance, and staleness. Treat the terminal service as protected surviving behavior, not #316 cleanup. |
| `TerminalInfo` and terminal RPC contracts | **Direct file overlap; semantic complement** | #316 removes several unrelated RPC families and preserves generic `terminal.spawn`. The redesign changes `AgentStatusSchema`, `TerminalInfo`, and `terminal.setAgentStatus` in the same monolithic [`packages/shared/src/rpc.ts`](../../packages/shared/src/rpc.ts) (current definitions around lines 1604–1794). #316 should shrink this file first to reduce merge/conflict risk. |
| Agent status semantics | **Direct complement** | #316 removes the obsolete embedded OpenCode producer but deliberately leaves replacement out of scope. ADR 0005 changes the surviving terminal model from `active | waiting_for_input | null` to `working | needs_input | idle | unknown | null`, with done derived from idle + unseen. Current duplicated renderer types remain in [`use-terminal-list.ts`](../../apps/web/src/hooks/use-terminal-list.ts) lines 42–80 and must be replaced after cleanup. |
| Hooks/plugins | **Hard sequencing dependency** | #316 deletes [`packages/server/src/services/mcp-registrar.ts`](../../packages/server/src/services/mcp-registrar.ts), whose lines 511–705 currently install/remove `laborer-hook.js` and map OpenCode busy/idle/error to `active`/`waiting_for_input`. Any redesign code placed there would be deleted. The replacement hook installer/adapters must be independent of MCP and introduced only after Phase 1. |
| Notifications | **Independent in #316's spec, but redesign replaces surviving implementation** | #316 does not request notification behavior changes. Today each renderer's [`use-agent-notifications.ts`](../../apps/web/src/hooks/use-agent-notifications.ts) performs workspace-level transition detection and checks `document.hasFocus()` (lines 64–139), exactly the ownership ADR 0006 rejects. The redesign should delete this policy hook and add a main-owned coordinator. |
| Workspace visibility/focus | **Complement with existing infrastructure; file overlap** | #316's workspace cleanup changes workspace/panel UI, but says workspace lifecycle remains unchanged. Existing [`ipc.ts`](../../apps/desktop/src/ipc.ts) has a `WorkspaceWindowRegistry`, visible-workspace reports, notification click routing, and focus routing (lines 121–170 and 612–707). The redesign should reuse or extract these facts, extend them with focused-window semantics, and support opening a non-visible workspace. Because #316 edits IPC sidecar validation and panel/workspace files, cleanup should land first. |
| Electron main | **Direct file-level overlap** | #316 Phase 1 edits the utility-process fork list and IPC validation. Existing [`main.ts`](../../apps/desktop/src/main.ts) still forks `mcp` at lines 460 and 504, and [`utility-process-manager.ts`](../../apps/desktop/src/utility-process-manager.ts) includes `mcp` in `ServiceName` and path resolution. The redesign adds a long-lived notification coordinator to main. Land Phase 1 first, then wire the coordinator into the simplified startup graph. |
| Workspace status UI | **Direct file overlap; semantic complement** | #316 modifies [`workspace-list.tsx`](../../apps/web/src/components/workspace-list.tsx), [`workspace-dashboard.tsx`](../../apps/web/src/components/workspace-dashboard.tsx), and [`routes/index.tsx`](../../apps/web/src/routes/index.tsx) to remove plan/task/review UI. Those files also consume terminal status or notification hooks (`index.tsx` currently calls `useAgentNotifications`; workspace list derives attention from `waiting_for_input`). Status labels/ranking/done projection should be integrated after #316 removes the dead branches. |
| LiveStore | **Independent and aligned** | #316 carefully preserves historical Task/PRD event decoding while removing active tables. The redesign explicitly keeps status ephemeral and adds no LiveStore events (ADR 0005). There is no schema conflict beyond concurrent edits to broad shared files/tests. |
| Sidecar status UI | **Adjacent, not agent status** | #316 removes `mcp` from sidecar status types/UI; this is process health, not semantic agent status. Do not conflate `SidecarStatusEvent` with `TerminalInfo.agentStatus`. |

### Conflict assessment

There is no product-level contradiction. The one potential implementation conflict is **building a replacement status plugin in `McpRegistrar` or `packages/mcp`**, both explicit deletion targets. A second practical conflict is concurrent modification of broad files (`packages/shared/src/rpc.ts`, `apps/desktop/src/ipc.ts`, `apps/desktop/src/main.ts`, `routes/index.tsx`, workspace list/dashboard, shared fixtures). Both are avoided by sequencing #316 first.

## Blocker recommendation

Because the tree contains only one ticket, classification applies to #316 itself and its internal phases.

### Should block the status/notification implementation

- **#316 as a whole — recommended.** It is a large simplification changing exactly the integration surfaces the redesign needs. Landing it first gives the redesign a smaller RPC file, smaller workspace UI, two-sidecar startup graph, and no obsolete plugin host.
- **At absolute minimum, #316 Phase 1 is a hard blocker.** It deletes the old OpenCode plugin and modifies Electron startup/IPC/sidecar types. New hook installation and main coordinator wiring should target the post-Phase-1 architecture.
- **Phases 2–4 are practical blockers for UI and shared-contract integration.** They edit the broad RPC and workspace UI files. Although status core logic in isolated new modules could be developed in parallel, final integration should wait.

### Should be blocked by the redesign

- **None.** #316 explicitly makes replacement status-hook behavior Out of Scope and requires terminals to keep working, not to acquire the new behavior. Adding the redesign as a blocker would unnecessarily couple deletion to feature repair.

### Independent work

- **ADR/domain documentation and isolated design/test scaffolding** for the redesign can land independently, provided #316's documentation sweep does not accidentally purge the new records.
- **Pure new-module implementation** of the terminal state machine or notification transition/debounce logic can be prepared after Phase 1 and in parallel with later #316 phases, but contract/UI/main wiring should be rebased onto completed #316.

### Recommended landing sequence

1. Land #316 Phase 1 (MCP, `McpRegistrar`, old OpenCode plugin, sidecar wiring deletion).
2. Preferably finish and land #316 Phases 2–6; verify terminals/workspaces still pass their preserved seams.
3. Add the redesigned terminal status core and detector adapters as new terminal-package modules; adapt `TerminalManager` and terminal RPC contracts.
4. Add the Electron main notification coordinator and extract/extend window visibility/focus/click routing.
5. Delete renderer notification policy, retain only visibility/focus reporting and in-app status projection; integrate status UI in the now-simplified workspace surfaces.
6. Run terminal package tests first, then desktop/web tests and the full `current` check.

## Rewrite opportunity after #316

### Files/modules #316 deletes or structurally replaces

- **Delete entirely:** `packages/mcp/**`.
- **Delete entirely:** `packages/server/src/services/mcp-registrar.ts` (including its OpenCode plugin installer).
- **Edit, not delete:** Electron utility-process manager/types, lifecycle/fork list, dev watcher, `ipc.ts`, `main.ts`, preload/shared sidecar union, sidecar UI, packaging scripts.
- **Edit heavily, not delete:** shared RPC/schema files and workspace/panel/sidebar/dashboard UI.

### Surviving files #316 does *not* promise to delete

- `packages/terminal/src/services/terminal-manager.ts`
- `apps/web/src/hooks/use-terminal-list.ts`
- `apps/web/src/hooks/use-agent-notifications.ts`
- `apps/desktop/src/ipc.ts`
- `apps/desktop/src/main.ts`
- `packages/server/src/services/terminal-client.ts` and its `/hook/agent-status` proxy

Thus “fully new” should mean **new deep modules behind surviving entry points**, not assuming those surviving files disappear.

### Best new-module seams

1. **Terminal status engine (new):** isolate semantic state, seen tracking, process-scoped hook evidence, sequence guards, ps confirmation counters, failure/staleness, and transition emission from the already very large `terminal-manager.ts`. `TerminalManager` should own lifecycle and delegate status arbitration to this module.
2. **Agent adapters/installers (new):** create MCP-independent Claude/OpenCode/opencode2 hook adapters and installation code. Do not resurrect generic agent configuration inside the deleted `McpRegistrar`.
3. **Main notification coordinator (new):** a dedicated desktop module should own per-terminal transition history, 1-second replaceable debounce, revalidation, app-wide focus suppression, and click intent. `main.ts` wires it; `ipc.ts` should only validate/route facts.
4. **Window/workspace presence registry (extract or replace):** move the current `WorkspaceWindowRegistry` out of `ipc.ts`, add focused-window/visibility queries and a route-to-or-open-workspace operation. This makes the coordinator testable without the giant IPC module.
5. **Renderer simplification:** delete `use-agent-notifications.ts` and `agent-notification-transitions.ts` after main ownership exists. Keep or introduce a narrowly scoped reporter for visible workspace IDs/window activity. `use-terminal-list.ts` remains the stream/list cache but should consume the canonical shared `TerminalInfo` type rather than redefining status contracts.
6. **UI projections (new pure module):** encode per-terminal `done = idle && !seen`, workspace aggregation, and attention ranking in pure tested functions, then apply them to the simplified post-#316 workspace UI.

## Risks and cautions

- #316's docs phase says to purge stale brrr/rlph/plan/task/MCP claims. Preserve ADRs 0005/0006 and this research note as current architectural evidence; do not treat every occurrence of “MCP” in root research as dead source code.
- The issue says terminals remain “unchanged,” so #316's implementation should not opportunistically alter status semantics. Keep cleanup and behavior redesign reviewable as separate changes.
- Existing notification click routing falls back to an existing window and sends `NOTIFICATION_CLICKED_CHANNEL`; it does not itself prove that a workspace absent from all visible layouts can be opened. The redesigned coordinator must add that behavior rather than assuming the current registry satisfies it.
- Current visibility reports identify visible workspaces, but app-wide suppression requires actual `BrowserWindow` focus state at delivery/revalidation time. Visibility alone is insufficient.
