# Laborer agent notifications and statuses

**Research date:** 2026-08-08  
**Scope:** Primarily the legacy desktop app in `apps/desktop/`; brief comparison with the Slack-native `apps/bot/`.
**Method:** Repository source/tests/docs, Git history, and GitHub issue/PR searches for `izakfilmalter/laborer`.

> **Historical snapshot:** This document records the architecture observed on the research date. LiveStore and the two-value agent-attention model described below have since been removed; this is evidence for earlier design work, not current implementation guidance.

## Executive summary

The legacy app does **not** have a durable Agent, agent session, or agent run model. It has three adjacent layers:

1. durable LiveStore workspace lifecycle (`creating | running | stopped | errored | destroyed`),
2. in-memory terminal lifecycle (`running | stopped`) plus process metadata, and
3. an ephemeral, two-value terminal agent-attention signal (`active | waiting_for_input | null`).

The two agent values are too coarse to distinguish **waiting for a person**, **successfully done**, and **errored**. In fact, the code explicitly treats “needs input or completed” as one state, OpenCode maps `session.error` to `waiting_for_input`, and Claude maps both `Stop` and `Notification` to it. Native notifications only fire for the aggregate workspace transition `active -> waiting_for_input`, only from an unfocused renderer, with no durable unread state, timeout, main-process deduplication, preference controls, or dock badge.

Hook callbacks make Claude/OpenCode more accurate than process inspection, but the hook override has no lease or timeout and wins forever until another hook, restart/removal, or explicit `clear`. Hook delivery failures are silently swallowed. Codex and rlph are advertised as supported but are not hook-enabled; their waiting detection depends on the weaker process-transition heuristic.

The strongest evidence that this area is fragile is its repair history: PR #60 added hooks because persistent interactive CLIs never became “waiting” under process inspection; PR #66 fixed stuck OpenCode attention and false sub-agent completions; PR #143 reports hooks failed about 99% of the time due plugin installation timing; PR #148 repaired another complete hook-delivery break after the utility-process migration.

---

## 1. Status model at the research date

### 1.1 There is no legacy Agent/session/run record

No shared LiveStore table or RPC entity represents an Agent, agent session, or agent run. An “agent” is a command running in a terminal, and its status is attached ephemerally to `TerminalInfo`.

The nearest durable/shared types are:

| Concept | Type/schema | Values | Evidence |
|---|---|---|---|
| Workspace lifecycle | `WorkspaceStatus` | `creating`, `running`, `stopped`, `errored`, `destroyed` | `packages/shared/src/types.ts:26-33` |
| Terminal lifecycle | `TerminalStatus` | `running`, `stopped` | `packages/shared/src/types.ts:38-39` |
| Agent attention | `AgentStatusSchema` / `AgentStatus` | `active`, `waiting_for_input` (or `null` in `TerminalInfo`) | `packages/shared/src/rpc.ts:1604-1613`, `1620-1649` |
| Process category | `ProcessCategorySchema` | `agent`, `editor`, `devServer`, `shell`, `unknown` | `packages/shared/src/rpc.ts:1570-1587` |
| Sidecar health | `SidecarStatusEvent` | `starting`, `healthy`, `unresponsive`, `crashed`, `restarting` | `packages/shared/src/desktop-bridge.ts:15-39` |

`TerminalInfo` carries `agentStatus`, `foregroundProcess`, `hasChildProcess`, `processChain`, and terminal `status`; these are the actual status inputs consumed by the UI (`packages/shared/src/rpc.ts:1620-1649`).

### 1.2 LiveStore model and historical events

The `workspaces` LiveStore table has a text `status` defaulting to `creating` and an `errorMessage` used for `errored` (`packages/shared/src/schema.ts:20-70`). `v1.WorkspaceStatusChanged` persists workspace status changes (`packages/shared/src/schema.ts:212-220`) and its materializer clears/sets setup and error fields depending on the new status (`packages/shared/src/schema.ts:688-701`).

A legacy `terminals` table and these persisted event definitions still exist:

- `v1.TerminalSpawned`
- `v1.TerminalOutput`
- `v1.TerminalStatusChanged`
- `v1.TerminalKilled`
- `v1.TerminalRemoved`
- `v1.TerminalRestarted`

See `packages/shared/src/schema.ts:73-82,333-386`. However, terminal state was deliberately moved out of LiveStore in Issue #145: terminal materializers are no-ops (`packages/shared/src/schema.ts:786-791`) and `terminals` is excluded from `activeTables` while retained for compatibility (`packages/shared/src/schema.ts:877-896`). Therefore **agent status is neither a LiveStore column nor a persisted event**.

### 1.3 Terminal RPC contract and transition writers

`TerminalRpcs` exposes:

- `terminal.spawn`, `write`, `resize`, `kill`, `remove`, `restart`, `list`, `events`; and
- `terminal.setAgentStatus`, whose payload event is `active | waiting_for_input | clear`.

See `packages/shared/src/rpc.ts:1653-1812`. The event stream union includes `Spawned`, `StatusChanged`, `Exited`, `Removed`, `Restarted`, and full-record `ProcessChanged` (`packages/shared/src/rpc.ts:15-72`). Agent/process changes are pushed as `ProcessChanged`; they are not LiveStore events.

The terminal service owns the mutable state:

- `agentStatusMap` remembers ps-derived transitions;
- `hookAgentStatusMap` stores hook overrides;
- the latter takes precedence in `toTerminalRecord`.

See `packages/terminal/src/services/terminal-manager.ts:903-917,1627-1657`. `setAgentStatusFromHook` writes both maps and immediately emits `ProcessChanged`; `clear` removes only the override and returns to process detection (`packages/terminal/src/services/terminal-manager.ts:2125-2180`). Restart and removal clear both maps (`packages/terminal/src/services/terminal-manager.ts:1575-1616,1845-1847`).

The renderer hydrates once with `terminal.list`, then keeps a module-level list current through `terminal.events`, retrying the stream with exponential backoff (`apps/web/src/hooks/use-terminal-list.ts:1-20,281-353`).

---

## 2. Status detection and transitions

### 2.1 Process inspection fallback

Every 200 ms, `TerminalManager` collects shell PIDs, executes one `ps -eo pid=,ppid=,comm=`, walks each process tree up to ten first-child levels, classifies known processes, diffs full records, and emits `ProcessChanged` (`packages/terminal/src/services/terminal-manager.ts:462-587,2182-2299`). Known agent names include Claude, OpenCode/OpenCode 2, Codex, Aider, Goose, Cursor, Cline, Continue, Amp, Kilo Code, Roo Code, and Gemini (`packages/terminal/src/services/terminal-manager.ts:231-254`).

The ps-derived state machine in `computeAgentStatus` is:

- any agent anywhere in `processChain` -> `active`;
- previous `active` followed by null/shell foreground -> `waiting_for_input`;
- remain waiting while null/shell;
- a non-agent, non-shell foreground process clears status to `null`.

See `packages/terminal/src/services/terminal-manager.ts:1064-1123`. Checking the full chain is important because an agent may spawn a tool subprocess; PR #65 fixed the former deepest-process-only behavior ([PR #65](https://github.com/izakfilmalter/laborer/pull/65)).

OSC title and OSC 133 prompt signals supplement ps for faster activity feedback. OSC may upgrade child-process activity but deliberately cannot downgrade it; ps is authoritative. A no-OSC newline heuristic resets after 10 seconds (`packages/terminal/src/services/terminal-manager.ts:590-695,923-1054`). This mechanism primarily improves process/activity display; agent state still comes from process classification unless a hook overrides it.

### 2.2 Agent lifecycle hooks

The server starts a localhost HTTP server on an OS-selected port at `/hook/agent-status`; it validates `terminalId` and `active | waiting_for_input | clear`, then forwards the event through `terminal.setAgentStatus` RPC (`packages/server/src/services/terminal-client.ts:112-202`). Host agent spawns receive `LABORER_TERMINAL_ID` and `LABORER_HOOK_URL` (`packages/server/src/services/terminal-client.ts:758-827`).

Only `claude`, `opencode`, and `opencode2` are in `HOOKABLE_AGENTS`; Codex and rlph are not (`packages/server/src/services/terminal-client.ts:424-432`).

- **Claude Code:** injected `--settings` hooks post `active` on `SessionStart`, and `waiting_for_input` on both `Stop` and `Notification` (`packages/server/src/services/terminal-client.ts:434-510`). There is no explicit per-turn “busy again” hook shown after the initial session start, so correctness depends on Claude's hook semantics and/or ps fallback; the persistent override can remain waiting.
- **OpenCode:** a globally installed plugin posts `active` for a root `session.created` or root `session.status=busy`, `waiting_for_input` for root `session.status=idle`, and also `waiting_for_input` for root `session.error`; child sessions are tracked and ignored (`packages/server/src/services/mcp-registrar.ts:523-590`).

### 2.3 Meaning of running, waiting, done, and error

- **Running/active agent:** an agent-classified process appears anywhere in the process chain, or a hook reports `active`.
- **Waiting:** a hook reports `waiting_for_input`, or a previously active process returns to shell/no foreground process.
- **Done:** there is no done/completed agent state. Shared documentation says `waiting_for_input` means an agent “needs user input **or has completed its task**” (`packages/shared/src/rpc.ts:1604-1610`).
- **Errored:** there is no agent error state. OpenCode `session.error` is mapped to `waiting_for_input` (`packages/server/src/services/mcp-registrar.ts:582-586`). Terminal process exit emits `StatusChanged(stopped)` and a separate `Exited(exitCode, signal)` (`packages/terminal/src/services/terminal-manager.ts:1806-1829`), but the web reducer treats `Exited` as informational and discards its exit information (`apps/web/src/hooks/use-terminal-list.ts:255-258`).

### 2.4 Detection weaknesses

#### Verified historical failures

- **Persistent CLIs never became waiting under ps inspection.** PR #60 says interactive agent CLIs stay running as foreground processes, so hooks were added to fix completion notifications ([PR #60](https://github.com/izakfilmalter/laborer/pull/60)).
- **Stuck OpenCode attention and false sub-agent attention.** PR #66 says an existing OpenCode session did not report busy again, so “needs input” failed to clear; deprecated `session.idle` also caused child-agent completions to trigger false notifications ([PR #66](https://github.com/izakfilmalter/laborer/pull/66)).
- **Plugin timing made status reporting fail roughly 99% of the time.** PR #143 moved plugin installation to server startup because per-spawn installation was too late and produced no amber state or notification ([PR #143](https://github.com/izakfilmalter/laborer/pull/143)).
- **Utility-process migration broke all hook delivery.** PR #148 says the old HTTP endpoint disappeared and port `0` was injected, silently breaking both OpenCode and Claude until a proxy server/RPC endpoint was restored ([PR #148](https://github.com/izakfilmalter/laborer/pull/148)).

#### Current structural gaps

1. **No lease/timeout on hook overrides.** `hookAgentStatusMap` stores only a status, not time or generation, and wins over ps indefinitely (`packages/terminal/src/services/terminal-manager.ts:912-917,1635-1643`). A lost “busy” or “idle” callback can leave the UI stuck forever. There is no stale-status timer.
2. **Hook transport intentionally hides failures.** OpenCode's plugin wraps `fetch` in `catch {}` and has no retry/ack logic (`packages/server/src/services/mcp-registrar.ts:550-558`); Claude's curl redirects all output and errors to `/dev/null` (`packages/server/src/services/terminal-client.ts:451-493`). The renderer also silently ignores notification-send failures (`apps/web/src/hooks/use-agent-notifications.ts:129-137`).
3. **`ps` failure looks like idle.** `execAsync` returns `null` for any error/3-second timeout; `detectProcessesForPids` then returns `EMPTY_DETECTION` for every terminal (`packages/terminal/src/services/terminal-manager.ts:359-395,557-576`). For a prior ps-derived `active` state, that empty result satisfies the transition to `waiting_for_input`, so a transient ps failure can produce a false notification. The tests found cover classification and hook map behavior but not a ps-failure-to-false-waiting case.
4. **“Waiting,” “done,” and “error” are collapsed.** This prevents precise UI text, notification severity, completion sounds, error handling, or distinct filtering.
5. **Uneven provider accuracy.** Only Claude/OpenCode are hookable. Codex and rlph rely on the heuristic that PR #60 already found insufficient for long-lived interactive CLIs, despite the README broadly claiming support for OpenCode, Claude, Codex, and rlph (`apps/desktop/README.md:35-39`; `packages/server/src/services/terminal-client.ts:424-432`).
6. **First-child tree walking is heuristic.** `walkProcessTree` follows only `grandchildren[0]` and caps depth at ten (`packages/terminal/src/services/terminal-manager.ts:462-483`); agents with multiple child branches can be misrepresented, although the root-agent inclusion fix reduces this for common cases.
7. **No durable status age or provenance.** `TerminalInfo` does not say whether status came from hook, ps, or when it changed (`packages/shared/src/rpc.ts:1620-1649`), making stale-state diagnosis and UI trust cues impossible.

---

## 3. Notifications

### 3.1 Native desktop notification flow

At app root, `apps/web/src/routes/index.tsx:913-944` calls `useAgentNotifications` with the global terminal list and all workspaces. The hook:

1. groups terminals by workspace;
2. aggregates status with priority `waiting_for_input > active > null`;
3. compares the prior and current maps;
4. triggers only `active -> waiting_for_input`;
5. always triggers a `haptics.notification()` nudge for that transition;
6. sends an Electron native notification only when `document.hasFocus()` is false.

See `apps/web/src/lib/workspace-agent-status.ts:14-40`, `apps/web/src/lib/agent-notification-transitions.ts:1-43`, and `apps/web/src/hooks/use-agent-notifications.ts:71-139`. The notification title is the workspace branch and body is fixed to “Agent is waiting for input.”

The preload bridge exposes `sendNotification` and `onNotificationClicked` (`packages/shared/src/desktop-bridge.ts:126-141,260-266,306-311`; `apps/desktop/src/preload.ts:172-182`). Electron's main process validates the payload, checks `Notification.isSupported()`, constructs `new Notification({title, body})`, and shows it (`apps/desktop/src/ipc.ts:634-680`). On click it prefers the window that reported the workspace visible, otherwise a fallback window; it shows/focuses that window and sends the workspace ID back (`apps/desktop/src/ipc.ts:663-677`). The renderer then activates the first active-tab leaf belonging to that workspace (`apps/web/src/routes/index.tsx:924-949`).

### 3.2 Dedupe and focus awareness

There is minimal dedupe: the pure transition detector will not repeat while a workspace remains waiting, and it intentionally ignores initial `null/missing -> waiting` hydration (`apps/web/test/agent-notification-transitions.test.ts:18-39`). This state exists only in a hook-local `useRef` (`apps/web/src/hooks/use-agent-notifications.ts:76-79`).

There is **no main-process dedupe**, notification ID/tag, cooldown, durable delivery record, or acknowledged/read state. Because every Electron renderer mounts the hook, multiple unfocused windows can independently send the same native notification; a focused window only suppresses its own send, not sends from other background windows. This follows directly from renderer-local transition/focus state and the unconditional main-process `notification.show()` path.

Focus awareness is only `document.hasFocus()` at send time. It does not check whether the specific workspace/terminal is visible, whether another Laborer window is focused, or whether the user is already viewing the waiting workspace.

Notification click routing can also be a no-op: the main process falls back to a window when no window reports the workspace visible, while the renderer callback only searches currently active-tab leaves and does nothing if none match (`apps/desktop/src/ipc.ts:663-677`; `apps/web/src/routes/index.tsx:924-937`).

### 3.3 Other notification-like mechanisms

- **Haptic/audio-like nudge:** `web-haptics` preset `nudge` is called even when focused, but only after user interaction because browser vibration/audio APIs are gated (`apps/web/src/lib/haptics.ts:20-52,100-108`). `WebHaptics` is instantiated with `debug: true` (`:49-51`).
- **In-app toasts:** Sonner is installed globally and used for operation success/failure; agent waiting does **not** create an in-app toast (`apps/web/src/routes/__root.tsx:18,107`; absence in `use-agent-notifications.ts`). Sidecar crashes have separate deduped error/recovery toasts (`apps/web/src/hooks/use-sidecar-crash-listener.ts`).
- **Tray:** the tray exists, but agent attention does not affect it. Its icon is static and tooltip only reports count of LiveStore workspaces whose workspace status is `running` (`apps/desktop/src/tray.ts:17-89`; `apps/web/src/hooks/use-tray-workspace-count.ts:21-52`).
- **Dock badge/bounce:** no `app.dock.setBadge`, `setBadgeCount`, or `dock.bounce` use was found in `apps/desktop/src`.
- **Custom sounds:** native notifications do not set a sound, and there is no agent-specific sound preference. Any OS notification sound is platform/default behavior rather than app logic.

### 3.4 Notification weaknesses

- It notifies only one transition; terminal stops/errors, initial already-waiting state, and `active -> null` never notify (`apps/web/src/lib/agent-notification-transitions.ts:25-42`).
- Workspace aggregation can hide per-agent sequencing: if one terminal is already waiting, another terminal's `active -> waiting` does not change aggregate workspace status and produces no second notification (`apps/web/src/lib/workspace-agent-status.ts:17-39`).
- Conversely, a workspace can pulse forever because no acknowledgment/read mechanism clears attention; only process status changes do.
- No notification preferences, provider/workspace muting, quiet hours, rate limiting, history, or permission guidance are present.
- Main-process validation rejects malformed input silently and `Notification.isSupported() === false` is also silent (`apps/desktop/src/ipc.ts:636-659`).

---

## 4. UI presentation

### 4.1 Terminal rows

`TerminalList` preserves terminal-service list order; it filters by workspace and directly maps without status sorting (`apps/web/src/components/terminal-list.tsx:205-217,353-377`). `getTerminalDisplay` renders:

- stopped: muted terminal/agent icon and `stopped` badge;
- waiting: agent/root icon and pulsing amber `needs input` badge;
- no foreground: green `idle` badge;
- agent process: blue `agent` badge;
- editor: amber `editor` badge;
- dev server: emerald `running` badge;
- unknown: green `running` badge.

See `apps/web/src/components/terminal-list.tsx:403-515,518-615`. It shows a full chain label such as `OpenCode › biome` and has dedicated icons for Claude, OpenCode/OpenCode 2, and Codex (`:403-478`).

### 4.2 Workspace-level attention

`deriveWorkspaceAgentStatus` gives any waiting terminal priority over all active terminals (`apps/web/src/lib/workspace-agent-status.ts:15-40`).

- Sidebar workspace card: waiting adds an amber pulsing border/glow (`apps/web/src/components/workspace-list.tsx:1072,1127-1133`). It does not add a separate durable unread dot/count.
- Workspace frame header: waiting adds an amber-tinted header/border and a pulsing amber `needs input` badge (`apps/web/src/components/workspace-frame-header.tsx:288-316,368-375`).
- Terminal row: pulsing amber `needs input` badge as above.

Workspace order is not reprioritized by agent attention; attention is visual only. Terminal order likewise is not attention-sorted.

### 4.3 Ambiguity in labels

The UI says “needs input” and native notifications say “waiting for input,” even though the source status also means completion and OpenCode error. This is a semantic mismatch between shared status definition and presentation (`packages/shared/src/rpc.ts:1604-1610`; `apps/web/src/components/terminal-list.tsx:556-572`; `apps/web/src/hooks/use-agent-notifications.ts:125-134`).

---

## 5. Known issues, history, and fragility

### 5.1 GitHub and Git history

Relevant merged PRs found by `gh pr list/view` and `git log`:

| PR | Finding |
|---|---|
| [#42: surface agent attention across workspaces](https://github.com/izakfilmalter/laborer/pull/42) | Introduced per-terminal transitions, workspace amber surfaces, and click-routed desktop notifications. |
| [#60: agent lifecycle hooks](https://github.com/izakfilmalter/laborer/pull/60) | Added hooks because process inspection could not detect waiting for persistent interactive CLIs. |
| [#65: include exec-replaced agent](https://github.com/izakfilmalter/laborer/pull/65) | Fixed agent status clearing while tool subprocesses ran. |
| [#66: notification clearing/sub-agents](https://github.com/izakfilmalter/laborer/pull/66) | Fixed stuck “needs input,” false child-agent completions, and stale plugins. |
| [#143: install plugin at startup](https://github.com/izakfilmalter/laborer/pull/143) | Reports plugin timing caused about 99% status/notification failure. |
| [#148: restore hook notifications](https://github.com/izakfilmalter/laborer/pull/148) | Fixed a utility-process migration regression that silently broke the hook URL for Claude and OpenCode. |

The requested `gh issue list --search` variants did not reveal an open legacy status/notification issue as of the research date. Searches mostly returned unrelated `apps/bot/` work items. The important historical records are PRs rather than standalone issues.

No status/notification-specific `TODO` or `FIXME` was found in the current source. This does not imply robustness; the merged fixes above document repeated regressions.

### 5.2 Relevant docs and architectural decisions

- `apps/desktop/README.md:35-39` advertises process-inspection status tracking and desktop notifications.
- Root `CONTEXT.md:145-203` defines the legacy app's workspace/terminal model and emphasizes that terminals outlive panes and continue unwatched.
- ADR 0003 says liveness signals are advisory and only explicit events end a terminal. A missed heartbeat must show `unresponsive` and allow manual restart rather than kill the terminal (`docs/adr/0003-advisory-liveness-explicit-terminal-lifecycle.md:1-21`). Any future status timeout should therefore mark status stale/unknown; it must not terminate a terminal or agent.

### 5.3 Highest-risk current behaviors

1. Hook statuses can stick indefinitely and have no age/provenance.
2. A ps command failure can masquerade as idle and generate false attention.
3. “needs input” is used for completion and error, so the UI may tell the operator to respond when no response is needed—or hide an error as ordinary waiting.
4. Multi-window renderers can duplicate native notifications; main owns display but not transition policy/dedupe.
5. Notification click fallback may focus a window but fail to open/activate a workspace absent from that window's active leaves.
6. Workspace aggregation loses per-terminal notifications once any terminal is already waiting.
7. Codex/rlph waiting support is weaker than the README presentation suggests.
8. Agent attention vanishes across terminal-service restart because it is in memory, while a restored process may take time to be rediscovered and hook overrides are cleared.

---

## 6. Architecture constraints for evolving status

`apps/desktop/AGENTS.md:37-47` states that the LiveStore event log is immutable:

- every persisted event definition that may exist historically must remain decodable;
- add fields only with `Schema.optional(...)` or `Schema.withDefault(...)`;
- rename/type changes require a new event version;
- old event definitions must remain;
- materializers should convert optional `undefined` to SQLite values (usually `?? null`);
- never add a required field to an existing event.

For this area specifically:

- Agent status currently lives in terminal-service memory/RPC, so enriching `TerminalInfo` or `ProcessChanged` does not require changing historical LiveStore events, but RPC rollout compatibility still needs care across separately running services/renderers.
- If agent/run/notification history becomes durable, introduce new event names/versions rather than repurposing `v1.TerminalStatusChanged`; its historical meaning is terminal `running/stopped`, not agent state.
- Keep all old terminal event definitions even though their materializers are now no-ops (`packages/shared/src/schema.ts:786-791`).
- ADR 0003 constrains timeout semantics: timeout may produce `unknown/stale/unresponsive`, but must not kill a terminal.
- Shared boundary models belong in `packages/shared`, not duplicated renderer/terminal aliases (`apps/desktop/AGENTS.md:21`). Today `AgentStatus` and related interfaces are duplicated in `use-terminal-list.ts` and `terminal-manager.ts`, which is a maintainability weakness relative to that rule.

---

## 7. Brief comparison: `apps/bot/`

The Slack-native implementation has a substantially richer **operator activity** model, but it is not the same as legacy CLI prompt detection.

- Work threads are projected as `in-progress | needs-attention | dormant` (`apps/bot/src/slack/work-thread-activity-projection.ts:1-23`; schema in `apps/bot/src/operator-status/protocol.ts:57-73`).
- `needs-attention` is derived from durable blocked outbox/turn/application-event state, unresolved conversation streams, or `recovery-blocked` executions; `in-progress` is derived from pending/running/delivery work and nonblocked executions (`apps/bot/src/slack/work-thread-activity-projection.ts:148-199`). This is explicit workflow state rather than process-name heuristics.
- Pending executions expose lifecycle `allocated | starting | implementation-ready | running | cancelling | recovery-blocked` (`apps/bot/src/operator-status/protocol.ts:30-51`). Elsewhere the coding application has richer terminal execution statuses including completed/failed/cancelled, but the operator protocol only projects nonterminal pending executions.
- The macOS companion popover prioritizes bindings/work threads needing action, uses danger/success/neutral tones, and shows relative time in state (`apps/bot/src/companion/renderer/status-popover.tsx:242-304,367-471`). The projection orders `needs-attention` before `in-progress` before `dormant` (`apps/bot/src/slack/work-thread-activity-projection.ts:245-249`).
- The companion tray changes to an attention glyph for daemon/binding health problems, but `trayPresentationFor` does not inspect work-thread attention; work-thread attention is visible after opening the popover (`apps/bot/src/companion/main.ts:43-121`).
- No Electron native OS notification, dock badge, toast, or custom sound implementation was found in `apps/bot/src` for work-thread state. Slack itself is the primary public update surface, consistent with root `CONTEXT.md:80-89`.

Useful lesson for legacy evolution: `apps/bot/` separates **in progress**, **needs intervention**, and **dormant**, tracks `stateChangedAt`, and derives attention from explicit durable blockers. Those concepts avoid the legacy model's “idle means waiting/done/error” collapse, though direct reuse would cross distinct product architectures.

---

## Historical recommendations

1. Define a richer shared agent activity union, at minimum separating `working`, `needs_input`, `completed`, `failed`, and `unknown/stale`, plus `source` and `changedAt`.
2. Treat hook state as leased evidence: expire to `unknown` or ps-derived state after a bounded period; never kill the terminal (ADR 0003).
3. Distinguish detection failure from empty detection so `ps` errors cannot synthesize waiting.
4. Move native-notification transition/dedupe ownership to the Electron main process (or a single app-wide coordinator), with workspace/terminal keys and app-wide focus awareness.
5. Add acknowledgment/unread semantics and click behavior that can actually open a nonvisible workspace.
6. Add provider contract tests for Claude/OpenCode and either implement Codex/rlph lifecycle sources or explicitly label them heuristic-only.
7. Preserve the then-existing legacy LiveStore events and create new versioned events if durable agent/notification history is introduced. This recommendation was superseded when that persistence architecture was removed.
