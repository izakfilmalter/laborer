# Herdr agent statuses and notifications

**Repository inspected:** `herdrdev/herdr` at `6f311498aeeb27c0973781961ef94e8d0016ed17` (2026-08-08)  
**Reference checkout:** `/Users/izakfilmalter/.local/share/opencode/repos/github.com/herdrdev/herdr@master`  
**Scope:** agent lifecycle classification, attention semantics, notification delivery, and status UI. All paths below are relative to that checkout.

## Executive summary

Herdr does **not** model `done` as a separate internal execution state. Its core `AgentState` has four values—`Idle`, `Working`, `Blocked`, and `Unknown`. Public/UI status adds `Done`, derived as `Idle` plus a pane-level `seen == false` bit. Thus “done” means “the agent became idle after work while its tab was not actively seen,” not a process exit or protocol completion signal.

Status comes from a layered system:

1. identify the foreground agent from OS process-group inspection (plus wrapper/runtime and `HERDR_AGENT` hints),
2. classify the terminal’s **live detection buffer** and OSC title/progress with per-agent TOML manifests,
3. optionally accept direct lifecycle reports from installed agent hooks/plugins over Herdr’s local socket API,
4. arbitrate those sources centrally, with full-lifecycle integrations authoritative while live, visible blocker recovery for other hook paths, sequence/session guards against stale reports, and explicit process-exit cleanup.

Notifications are transition-driven. `Blocked` produces a request/attention alert. A completion transition (`Working|Blocked -> Idle`, plus a guarded `Unknown -> Idle` case) produces a finished alert. Popups are suppressed for the active tab while Herdr’s outer terminal is focused; request **sounds** are intentionally still allowed there, while completion sounds are background-only. The default one-second notification delay acts as debounce/deduplication: one pending item exists per pane, any subsequent transition replaces/cancels it, and delivery revalidates both state and agent identity.

## 1. Agent status model

### Core state vs public/UI status

The core enum is `detect::AgentState` in `src/detect/mod.rs:9-20`:

- `Idle`: prompt visible / nothing happening,
- `Working`: actively processing,
- `Blocked`: needs human input,
- `Unknown`: plain shell or unrecognized/unclassifiable program.

The socket/API-facing `api::schema::AgentStatus` adds `Done` (`src/api/schema/common.rs:149-157`). The lower-level report input `PaneAgentState` still accepts only `idle`, `working`, `blocked`, and `unknown` (`src/api/schema/common.rs:140-147`), confirming that integrations do not directly report `done`.

`done` is a projection of state plus visibility:

- `PaneState.seen` is documented as “whether the user has seen this pane since its last state change to Idle”; false means Done (`src/pane/state.rs:3-18`).
- `state_label_text` maps `(Idle, false)` to `done` and `(Idle, true)` to `idle` (`src/app/actions.rs:891-898`).
- The bundled agent skill gives the product semantics: idle is ready for input and seen; done is the same underlying idle state after unseen background work; blocked is recognized approval/question UI; unknown does not prove completion (`skills/herdr/SKILL.md:54-58`).

There is **no distinct error or failed state**. Individual adapters may map errors to `Blocked`; for example, the OpenCode plugin maps `session.error` to blocked (`src/integration/assets/opencode/herdr-agent-state.js:187-193`). Process exit is not “error”: Herdr first publishes an idle process-exit transition so completion observers can see it, then clears/releases agent identity (`src/pane.rs:305-334`; `src/terminal/state.rs:277-374`).

### State transitions and `seen`

All effective changes flow through `TerminalState::recompute_effective_state` and `EffectiveStateChange` (`src/terminal/state.rs:77-87, 2006-2047`). `AppState::apply_pane_state_change` then updates attention state (`src/app/actions.rs:3070-3096`):

- every non-idle state sets `seen = true`;
- a genuine completion transition to idle sets `seen` according to whether active-tab notifications are suppressed;
- therefore a completion in a background tab becomes unseen/`done`, while a completion already visible in the active, focused tab remains seen/`idle`.

The completion predicate is normally `Working|Blocked -> Idle`; `Unknown -> Idle` also counts only when the previous and current non-empty agent labels match (`src/app/actions.rs:25-57`). This prevents a newly detected known agent’s initial idle state from appearing as finished.

Focusing/switching to the active tab marks every pane in that tab seen (`AppState::mark_active_tab_seen`, `src/app/actions.rs:1272-1291`). Outer-terminal focus gain also does this (`src/app/runtime.rs:235-250`), as does synchronizing a focused persistent client (`src/server/headless.rs:1085-1131`). CLI reads do not mark seen; focus operations do, per `skills/herdr/SKILL.md:56-58`.

## 2. Status detection mechanics

### A. Agent identity: foreground process inspection

Herdr first determines *which* agent owns a pane. `detect::Agent` lists 21 recognized tools (`src/detect/mod.rs:41-113`), and `identify_agent_in_job` prefers the foreground process-group leader before scoring other group members (`src/detect/mod.rs:210-244`). The process layer handles generic shells/runtimes and wrapped entrypoints in the remainder of `src/detect/mod.rs`.

The per-pane detector probes OS foreground jobs/process groups (`probe_foreground_process`, `src/pane.rs:497-619`). It is adaptive rather than continuously expensive:

- known agent: recheck every 5s,
- missing foreground group: every 30s,
- after new terminal activity with no known agent: a fast acquisition window of 8s, every 500ms for the first 1.5s then every 2s,
- acquisition resets after 2s without content change (`src/pane.rs:251-259, 412-486`).

A full-lifecycle hook authority can skip unchanged process probes, but process-group changes and exit cleanup still force probes (`src/pane.rs:400-445`). Agent loss is confirmed rather than immediately accepted: `AgentDetectionPresence` tracks consecutive misses, with six configured confirmation attempts (`src/pane.rs:251-265`; methods begin at `src/pane.rs:928`).

On a newly recognized agent, Herdr publishes initial idle and applies a 3s startup grace window before screen classification, preventing startup chrome from immediately causing noisy transitions (`AGENT_STARTUP_GRACE_WINDOW`, `src/pane/agent_detection.rs:12-13`; use at `src/pane.rs:769-827`).

### B. Screen/OSC detection: semantic manifests, not “no output for N seconds”

The detection module explicitly reads each pane’s **live bottom-of-buffer** text and matches known patterns (`src/detect/mod.rs:1-4`). Repository policy says not to use the user-visible viewport (which may be scrolled); detector evidence must come from the detection bottom buffer (`AGENTS.md:35`).

Each agent has a TOML manifest under `src/detect/manifests/`. Rules specify:

- semantic state (`idle`, `working`, `blocked`, `unknown`),
- priority,
- a structural region such as `bottom_non_empty_lines(3)`, `prompt_box_body`, `after_last_prompt_marker`, `osc_title`, or `osc_progress`,
- `contains`, regex, line-regex, nested all/any/not gates,
- confidence flags `visible_idle`, `visible_blocker`, `visible_working`,
- `skip_state_update` for transcript/model-picker viewers (`ManifestRule`, `src/detect/manifest.rs:138-181`).

Highest-priority matching rule wins (`evaluate_loaded_manifest`, `src/detect/manifest.rs:414-495`). If no rule matches for a *known* agent, the fallback is idle; only an unknown/no-agent input falls back to unknown (`fallback_explain`, `src/detect/manifest.rs:497-551`).

Concrete adapter examples:

- Claude: OSC braille title means working; live confirmation form/permission screens mean blocked; prompt box means idle; transcript and model picker screens skip updates (`src/detect/manifests/claude.toml:7-153`).
- Codex: “Action Required” OSC title is blocked; spinner title or live “Working (...esc to interrupt)” footer is working; a non-spinner title is idle; transcript viewer freezes current state (`src/detect/manifests/codex.toml:6-78`).
- OpenCode fallback: permission UI is blocked; interrupt hints/progress bar are working (`src/detect/manifests/opencode.toml:7-37`).

This is **not** a generic “no output for N seconds means idle” system. Terminal activity primarily schedules rescans and process acquisition; semantic screen/OSC evidence classifies the state. The project’s own architecture note explains why raw activity is insufficient: a spinner may redraw while blocked, a permission prompt may sit still, and subagent activity may coexist with a waiting parent (`website/src/content/blog/coding-agents-are-becoming-runtimes.md:121-132`).

### C. Scan/publish stabilization and CPU controls

The main Unix detection task runs every 300ms, or every 100ms while confirming a possible idle transition (`src/pane.rs:640-668`). It has several anti-flicker/efficiency controls:

- Unchanged idle bottom buffers are not rescanned; content sequence changes, agent/process changes, or pending idle confirmation force a read (`decide_detection_screen_read`, `src/pane/agent_detection.rs:80-138`).
- A plain `Working -> Idle` transition without visible idle/blocker evidence is held for three 100ms confirmations, capped at 700ms. Explicit visible idle bypasses the hold (`PendingIdleConfirmation`, `src/pane/agent_detection.rs:5-77`; tests at 429-469).
- Stable visible blocker evidence is refreshed at most every 800ms, useful for recovering from stale non-full-lifecycle reports without flooding updates (`src/pane/agent_detection.rs:10-11, 140-168`).
- State is published only when state/evidence/agent/process changes, or a blocker refresh is due (`src/pane/agent_detection.rs:140-210`).
- A 3s new-agent startup grace prevents premature screen transitions, as noted above.

### D. Direct tool integrations over Herdr’s local socket

Herdr does not use ACP, and the repository contains no ACP reference. Installed hooks/plugins invoke Herdr’s own newline-delimited local socket API (`pane.report_agent` / `pane.report_agent_session`) using injected `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`.

Examples:

- OpenCode serializes requests (`requestChain`) and maps native events/statuses: active/busy/running/streaming -> working; permission/question asked -> blocked; replies -> working; session idle -> idle; error -> blocked. It tracks child sessions so subagent events cannot replace root session identity (`src/integration/assets/opencode/herdr-agent-state.js:7-57, 105-200`).
- Pi reports `working` on `agent_start`, `idle` only on settled+`ctx.isIdle()`, and gives active blocked counters precedence. It serializes/coalesces queued state reports and attaches monotonic sequence/session data (`src/integration/assets/pi/herdr-agent-state.ts:56-73, 130-172, 175-256`; regression tests at `src/integration/assets/herdr-agent-state.test.ts:243-316`).

Source arbitration is centralized in `TerminalState`:

- `HookAuthority` records source, agent label, state, message, report time, and optional session ref (`src/terminal/state.rs:17-25`).
- Official full-lifecycle sources currently include Pi, OMP, MastraCode, OpenCode, Kilo, and Kimi; Hermes and Antigravity are session-identity-only (`src/detect/mod.rs:289-305`).
- A live full-lifecycle authority wins over screen fallback. For other/custom hooks, strong visible blocker evidence can override a non-blocked hook state. `recompute_effective_state` implements the final choice (`src/terminal/state.rs:2006-2022`), with the relevant authority predicates at `src/terminal/state.rs:1692-1758`.
- Hook reports carry optional monotonically increasing `seq`; `set_hook_authority_at` rejects stale/out-of-order, conflicting-agent, conflicting-owner, stale-session, and post-exit reports (`src/terminal/state.rs:598-711`; routing/sequence machinery throughout `src/terminal/state.rs:714-1179`).
- Confirmed process exit clears matching hook authority/session metadata and suppresses late reports from the exited generation (`src/terminal/state.rs:364-539`).

The Settings UI describes integrations as letting agents “report state directly instead of relying only on process detection” (`src/ui/settings.rs:304-331`). Available install targets include hook/plugin adapters for Pi, OMP, Claude, Codex, Copilot, Devin, Kimi, Droid, OpenCode, Kilo, Hermes, Qoder, Cursor, MastraCode, Antigravity, and Grok (`src/integration/actions.rs:38-234`), but their authority levels and event coverage differ; installing an integration does not imply every tool becomes fully hook-authoritative.

## 3. Notifications

### Triggers

Automatic agent notifications are derived only from effective state transitions:

- transition into `Blocked` -> `Sound::Request` and popup kind `NeedsAttention`,
- completion transition to `Idle` -> `Sound::Done` and popup kind `Finished`,
- no notification for same-state refreshes, entering `Working`, or `Unknown` except the guarded same-agent unknown-to-idle completion case (`src/app/actions.rs:25-57, 88-173`).

The content is concise:

- title: `<agent label> needs attention` or `<agent label> finished`,
- body/context: `<workspace label> · <1-based workspace index>`, plus tab label when multiple tabs exist (`notification_context`, `src/app/actions.rs:193-232`; toast construction at `src/app/actions.rs:3198-3216`).

### Focus awareness and active-tab policy

`active_tab_suppresses_notifications` returns true only when the pane is in the active tab and outer-terminal focus is true or unknown; explicit focus-lost disables suppression (`src/app/actions.rs:59-64`). Focus events come from terminal focus reporting and are tracked in `AppState.outer_terminal_focus` (`src/app/state.rs:1468-1470`; `src/app/runtime.rs:235-250`).

Consequences:

- **Popups:** both blocked and finished popups are suppressed for the active tab while focused (`notification_toast_for_*`, `src/app/actions.rs:134-173`). A focused pane can still alert when the whole terminal window is unfocused.
- **Sounds:** request/blocked sounds play even in the active tab; completion sounds are suppressed there (`src/app/actions.rs:88-130, 205-215`). This intentionally makes “needs input” more urgent than ordinary completion.
- **In-app toast:** only built for a non-active tab (`src/app/actions.rs:3218-3219`).

In persistent server mode, sound/toast messages are sent only to the foreground attached client, not broadcast to every client (`src/server/headless.rs:1852-1954`). That foreground client’s focus state is projected into app state (`src/server/headless.rs:1085-1131`).

### Debouncing, deduplication, and spam control

Automatic notifications have several layers of suppression:

1. They are transition-only; same-state updates produce nothing (`src/app/actions.rs:95-112, 141-158`).
2. Default `ui.toast.delay_seconds = 1` (`src/config/model.rs:1083-1091`). A pending record is keyed by pane. Every new state update first removes the prior pending record, so flapping replaces/cancels it (`src/app/actions.rs:3098-3165`).
3. At expiry, Herdr rechecks that the pane is still in the expected state and still belongs to the same agent before delivering (`src/app/actions.rs:3168-3191, 3261-3299`).
4. Active-tab/focus suppression is reevaluated at delivery time (`src/app/actions.rs:3193-3223`).
5. Pane death removes pending delivery (`src/app/actions.rs:3301-3303`).
6. Source-level stabilization—three idle confirmations, hook sequence/session checks, and effective-state arbitration—prevents transient detector noise from becoming notification transitions.

This delay applies to both sounds and popups because they are packaged in the same `PendingAgentNotification` / `AgentNotificationDelivery` (`src/app/state.rs:1330-1350`).

The separate manual `notification.show` API has its own one-notification-per-second rate limit, `Busy` handling for an existing in-app toast, and sanitization limits (80-char title, 240-char body) (`src/app/api.rs:20, 1189-1276`; result reasons in `src/api/schema/common.rs:122-130`). That rate limit is for API-triggered custom notifications, not the automatic agent transition path.

### Delivery channels

`ui.toast.delivery` selects (`src/config/model.rs:57-65`, defaults at 1083-1091):

- `off` (default): no popup,
- `herdr`: an in-TUI toast,
- `terminal`: ask the outer terminal to show a desktop notification,
- `system`: invoke the OS notification service directly.

Terminal delivery detects Ghostty, iTerm2, Kitty, or WezTerm. It emits OSC 9 for Ghostty/iTerm2/WezTerm and structured OSC 99 for Kitty, with tmux passthrough escaping when needed (`src/terminal_notify.rs:3-55, 65-105`).

System delivery uses:

- macOS: `terminal-notifier` when installed (including terminal activation on click), then `osascript` fallback (`src/platform/macos.rs:578-651`),
- Linux: `notify-send`, only with `DISPLAY` or `WAYLAND_DISPLAY` (`src/platform/linux.rs:534-568`),
- Windows: a native notification-area icon and info balloon on a dedicated thread; it explicitly uses `NIIF_NOSOUND`, leaving sound to Herdr’s separate sound system (`src/platform/windows.rs:1465-1554`).

Sounds are independent from popup delivery. `Sound::{Done, Request}` uses embedded MP3s, plays asynchronously, and can fall back from a custom MP3 to the built-in sound (`src/sound.rs:1-65`). Playback uses `afplay` on macOS, Windows MediaPlayer/PowerShell on Windows, and decoder-capable command-line players on Linux (`src/sound.rs:113-180` and later Linux implementation).

In-app toasts are temporary: attention 8s, finished 5s, update 3s (`src/app/api.rs:712-725`). `keys.open_notification_target` defaults to `prefix+o`, allowing navigation to the pane behind an in-app toast (`src/config/model.rs:374-375, 965-988`).

There is no persistent application tray or OS dock/taskbar badge system in this code. Windows temporarily creates a notification-area icon solely to emit its native balloon and removes it after ten seconds (`src/platform/windows.rs:1513-1554`). The durable “unread” mechanism is the `seen` bit rendered as `done` in Herdr’s own UI.

## 4. UI presentation and ordering

### Labels, colors, and icons

`ui::status` centralizes status visuals (`src/ui/status.rs:196-244`):

| Public status | Internal representation | Color token | Dots style | Symbols style |
|---|---|---|---|---|
| blocked | `Blocked` | red | `●` | `×` |
| working | `Working` | yellow | `●` | `◐` |
| done | `Idle`, unseen | teal | `●` | `✓` |
| idle | `Idle`, seen | green | `○` | `○` |
| unknown | `Unknown` | overlay0/dim | `·` | `·` |

One UI quirk: the generic sidebar `state_label` renders `Unknown` text as `idle`, even though the navigator/API and filter surfaces retain `unknown` (`src/ui/status.rs:227-234` versus `src/app/actions.rs:891-898`). The icon/color remains distinct and dim.

`ui.status_indicators` selects `dots` (default) or `symbols`; the Settings panel previews both (`src/config/model.rs:116-130, 1036-1066`; `src/ui/settings.rs:109-123`). Current indicators are static rather than animated; the project removed working spinners to avoid continuous redraw/CPU cost (`website/src/content/blog/ten-agents-three-clients-95-percent-less-cpu.md:19-51`).

### Attention rollups and sorting

Workspace/tab rollups choose the most urgent child in this order:

1. blocked,
2. done (idle unseen),
3. working,
4. idle seen,
5. unknown.

That order is explicit in `workspace::aggregate::pane_attention_priority` and `Workspace::aggregate_state` (`src/workspace/aggregate.rs:75-100`) and shared by `app::api_helpers::tab_attention_priority` (`src/app/api_helpers.rs:1-8`). Thus one unseen completion outranks ongoing work, while blocked outranks both.

The Agents panel always collects recognized agents across all workspaces (`src/ui/sidebar.rs:112-183`). Its default `ui.agent_panel_sort = "spaces"` preserves workspace/tab/pane grouping. `priority` sorts by descending attention priority, then descending `last_agent_state_change_seq` (most recent first within a priority) (`src/app/agent_view.rs:53-77`; config definition `src/config/model.rs:91-107`).

The session navigator supports status filters: blocked, working, idle-seen, and done-unseen (`src/app/actions.rs:864-874`), exposed as `b`, `w`, `i`, and `d` in the documented UI (`website/src/content/blog/herdr-0-6-3.md:44-46`). The mobile view summarizes counts in blocked/done/working/idle groups and leads with attention states (`src/ui/mobile.rs:993-1084`).

### “Unread” behavior

Herdr has no separate unread counter. `seen == false` is the unread/attention marker and changes display from idle to done. It is cleared when the user focuses the tab/pane or when the outer terminal returns focused (`src/app/actions.rs:1272-1291`; `src/app/runtime.rs:235-244`). Workspaces aggregate this bit, so an unseen completion can surface at workspace level even if other agents are working (`src/workspace/aggregate.rs:171-194` test).

## 5. Configuration and documentation

The generated current config reference is `docs/next/website/src/data/config-reference.json`:

- `ui.toast.delivery`: `off|herdr|terminal|system`, default `off` (`:754-768`),
- `ui.toast.delay_seconds`: 0–3600, default 1; delivery only if state still matches (`:769-774`),
- `ui.toast.herdr.position`: four corners, default bottom-right (`:775-786`),
- `ui.sound.enabled`: default true (`:810-818`),
- global/custom MP3 paths (`ui.sound.path`, `done_path`, `request_path`, `:819-836`),
- per-agent tri-state sound overrides (`default|on|off`, `:837-1045`); Droid defaults off while other listed agents default to inherited behavior,
- `ui.agent_panel_sort`: spaces or priority (`:695-704`),
- `ui.status_indicators`: dots or symbols (`:705-714`).

The backing types/defaults are `ToastConfig`, `ToastDelivery`, `StatusIndicatorStyle`, and `UiConfig` in `src/config/model.rs:57-130, 203-220, 807-867, 1036-1109`; per-agent sound policy is `SoundConfig`, `AgentSoundOverrides`, and `AgentSoundSetting` in `src/config/sound.rs:9-65, 119-183`.

There are no per-project notification settings in the inspected config model. Popup policy is global; sound can be overridden per **agent kind**, not per project/pane/session. Presentation metadata can customize labels/tokens, but it does not establish project-specific notification policy.

Detection manifests support bundled, remotely updated, and local override sources (`ManifestSource`, `src/detect/manifest.rs:49-72`; load precedence at `src/detect/manifest.rs:554-663`). `herdr agent explain` exposes matched rule/evidence and fallback reasons; `website/agent-guide.md:82` recommends it for wrong states. Integration install/status is available separately and reports current/outdated/not-installed state (`src/integration/types.rs:120-159`).

## Notable design takeaways

1. **Separate semantic lifecycle from attention/read state.** `Done = Idle + unseen` avoids forcing integrations to report a UI concern and makes completion acknowledgement a local interaction property.
2. **Treat detector sources as authorities with explicit arbitration.** Process identity, screen evidence, OSC signals, and tool events are not blindly merged; the effective-state seam is centralized in `TerminalState`.
3. **Prefer semantic evidence over inactivity timers.** Herdr uses terminal changes to schedule work, but attention is determined by explicit prompt/permission/status structures.
4. **Debounce at the notification boundary and revalidate.** A one-second per-pane pending delivery removes short flicker without delaying the state UI itself.
5. **Focus policy differs by urgency/channel.** Active focused completion is quiet; blocked request sound is not. Popups are suppressed more aggressively than sounds.
6. **Protect direct adapters from stale concurrency.** Sequence numbers, serialized request chains, root/child session separation, process-generation cleanup, and session anchoring are central—not incidental—because hook events can arrive late or out of order.

## Caveats

- This report describes the repository snapshot above, not a released binary with a potentially older embedded manifest/config schema.
- Some generated website/release docs under `docs/next` can be ahead of the stable root changelog; source code was treated as authoritative where they differed.
- “No ACP” is based on repository-wide source/docs search plus the concrete local-socket adapter implementations; it is not a claim about third-party plugins outside this repository.
