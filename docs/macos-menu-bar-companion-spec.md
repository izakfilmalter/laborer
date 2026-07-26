# macOS menu-bar companion

**Status:** Ready for issue breakdown

## Summary

Build a small macOS menu-bar companion that gives a local operator an immediate view of whether the Laborer daemon is running, which work threads are still doing or awaiting work, and which Action Executions remain outstanding.

The first implementation is deliberately a tracer, not a frozen interaction design. It must use real daemon state end to end, but row composition, ordering, titles, density, and popover behavior remain adaptation points to revise after hands-on use.

## User stories

1. As a Laborer operator, I want to see whether the daemon is running so I know whether Slack work can progress.
2. As a Laborer operator, I want daemon health to distinguish app-wide receiver connectivity from individual Slack workspace-binding readiness so one healthy connection cannot hide a failed binding.
3. As a Laborer operator, I want work grouped by Slack workspace so I can understand which installation owns it.
4. As a Laborer operator, I want every in-progress work thread visible so I can see what Laborer is doing or waiting for.
5. As a Laborer operator, I want pending Executions nested under their owning work threads so I can see which delegated work is outstanding.
6. As a Laborer operator, I want blocked work separated as needing attention so it cannot disappear into ordinary history.
7. As a Laborer operator, I want the four most recently dormant work threads in each workspace so I can verify that recent conversations settled.
8. As a Laborer operator, I want the dashboard to update without reopening it so its state remains trustworthy while I watch.
9. As a Laborer operator, I do not want the dashboard to expose prompts, private agent activity, secrets, commands, paths, or diagnostics.
10. As a Laborer operator, I want closing or crashing the companion to leave the daemon and active work running.

## Product decisions

- The product is the **Laborer companion**.
- It is an Electron application with a React status surface anchored to a macOS menu-bar item.
- Its component source uses shadcn/ui's Base UI implementation and Tailwind CSS v4. Radix-backed shadcn components are not part of this application.
- Its renderer uses TanStack Router so the initial status surface and Laborer's later graphical application share one typed navigation foundation.
- The same Chromium shell may grow into Laborer's later graphical application.
- It supports macOS 13 or newer and is intended for Apple Silicon and Intel.
- The first build is a developer preview, while its service and protocol boundaries must remain suitable for signed end-user distribution.
- The daemon is a separate per-user service owned by `launchd`, not by the companion process.

These architectural decisions are recorded in [ADR 0004](./adr/0004-electron-companion-observes-launchd-daemon.md).

## Dashboard

Clicking the menu-bar item opens a compact React surface. Content is grouped by Slack workspace. Each workspace can contain:

1. **In progress** — work threads with accepted work for which Laborer still owes progress.
2. **Needs attention** — work threads with an explicit durable blocker that requires intervention.
3. **Recent** — the four work threads that most recently became dormant in that workspace.

The initial work-thread row should try:

- channel and thread identity;
- a short, safe title derived without asking an agent to generate one;
- activity state and time in that state; and
- a nested summary of each pending Execution, including Action name, lifecycle state, and elapsed time.

These row details are hypotheses to evaluate in the tracer. The specification intentionally does not freeze exact order, typography, dimensions, disclosure behavior, completed-Execution history, or click behavior before the operator has used the application.

## Starting activity projection

The initial implementation should evaluate this precedence:

1. A work thread **needs attention** when durable state says it cannot progress or settle without intervention.
2. Otherwise it is **in progress** while participant input or an external event is queued or running, deliberate output is not settled, an Execution is nonterminal, or a terminal Execution event still awaits its Conversation-agent response.
3. Otherwise it is **dormant** after Laborer's deliberate response has reached Slack and no Execution remains nonterminal.

This is a starting projection, not a new source of truth. The first implementation must make state transitions visible enough to reveal where the model is wrong. Refinements belong in the daemon-owned projection rather than ad hoc companion heuristics.

## Daemon summary

The surface begins with:

- overall daemon availability;
- daemon version and uptime;
- connected, pending, and unavailable workspace-binding counts; and
- bounded binding detail when a workspace is not ready.

Receiver connectivity alone is not readiness. Workspace bindings initialize and fail independently.

## Architecture

### Authority

- The daemon and its Runners remain authoritative for workspace-binding, work-thread, turn, delivery, and Execution state.
- The companion receives a bounded operator projection. It does not derive state by reading live snapshot files, scraping logs, probing the Runner lock, or querying Slack independently.
- The existing Runner lock remains an exclusive-ownership mechanism, not a status or control API.
- The projection must remain independent of the legacy-versus-ACP Conversation adapter choice tracked by #242.

### Local protocol

- Add a narrow, versioned, local operator protocol owned by the daemon.
- Initial connection returns a complete status snapshot; subsequent events update that snapshot without polling runtime files.
- Reconnection obtains a fresh snapshot before applying later events.
- Unknown protocol versions, malformed records, stale sequences, and oversized records fail closed and surface bounded incompatibility or unavailable states.
- The protocol exposes stable identities and safe summaries, never raw persisted records.
- Transport and local authentication should be proved by the first tracer slice before being treated as a permanent implementation choice.

### Process lifecycle

- Product operation uses a per-user LaunchAgent registered with macOS Service Management.
- The daemon continues running when the companion exits.
- The daemon executable, Electron application, and protocol are versioned compatibly.
- LaunchAgent registration, first-run approval, executable packaging, signing, logs, and update behavior are delivery work, not assumptions supplied by the UI.

### Renderer boundary

- The Electron main process is the only companion process allowed to reach the local daemon protocol.
- The React renderer runs without Node integration, with context isolation and sandboxing.
- A narrow preload bridge exposes only the validated operator view model and harmless navigation intents.
- Slack credentials and daemon control credentials never enter the renderer.
- Initialize and add shadcn components with the Base UI component base (`--base base`) and keep the generated component source in the repository.
- Use Tailwind CSS v4's CSS-first configuration and semantic theme variables; do not introduce a Tailwind v3 compatibility configuration.
- Prefer installed shadcn components for ordinary interactive primitives instead of recreating their accessibility and state behavior locally.
- The shadcn component base is a constraint, not a visual design: layout, density, typography, and theme tokens remain specific to the Laborer companion.
- Use TanStack Router's file-based React routing with its Vite plugin and generated, type-registered route tree.
- Use hash history in the packaged Electron renderer so navigation and reload do not depend on an HTTP server or rewrite rules; tests may substitute memory history.
- Keep daemon status outside router state. Routes consume the validated operator view model supplied through the preload boundary.

## Privacy and disclosure

The ordinary dashboard may expose only what is needed to identify and understand current work:

- workspace, channel, and work-thread identity;
- safe title or bounded root-message excerpt;
- activity state and timestamps;
- Action name and bounded Execution lifecycle summary; and
- sanitized workspace or work-thread blocker categories.

It must not expose:

- Slack tokens or local protocol credentials;
- full participant prompts or Conversation-agent messages;
- thoughts, plans, tool calls, tool inputs, or tool outputs;
- handler or implementation-agent output;
- commands, environment variables, worktrees, branches, or filesystem paths;
- raw provider, ACP, Slack, or persistence diagnostics; or
- unbounded text from any source.

## First-release scope

The first release is observational. It includes:

- the menu-bar item and React surface;
- live daemon and workspace-binding state;
- workspace-grouped in-progress, needs-attention, and recent work threads;
- pending Execution summaries; and
- clear loading, daemon-unavailable, incompatible, empty, and partial-binding-failure states.

It excludes:

- Slack installation and authentication;
- workspace or Laborer-root configuration;
- editing `laborer.json`;
- daemon stop, restart, retry, abandon, or recovery controls;
- reading conversations or implementation output inside the companion;
- notifications;
- completed-Execution history;
- a general logs or diagnostics viewer;
- automatic title generation;
- remote access or multi-machine daemon discovery; and
- final visual polish before the tracer has been used.

Opening the canonical Slack thread may be added if a safe permalink is already available through the daemon projection; it is not required to prove the first tracer.

## Acceptance

The complete first release is accepted when:

- a developer can launch the companion with one documented command;
- clicking its menu-bar item opens the React status surface without showing a Dock icon;
- the renderer uses repository-owned shadcn component source backed by Base UI and styled with Tailwind CSS v4, with no Radix primitive dependency;
- the renderer boots through TanStack Router, and its packaged hash-history routes survive navigation and reload;
- the surface reports a real running or unavailable daemon rather than fixture state;
- workspace groups reflect real binding readiness independently;
- real work-thread and Execution changes appear without reopening the surface;
- every in-progress and needs-attention work thread is visible under its owning workspace;
- each workspace shows no more than its four most recently dormant work threads;
- quitting the companion leaves the daemon and active work running;
- reconnecting or restarting either process converges to a fresh authoritative snapshot;
- malformed, stale, incompatible, or unavailable protocol state fails closed without crashing either process;
- automated tests exercise the daemon projection, local protocol, preload boundary, and rendered behavior without Slack credentials; and
- an operator can use the tracer and report which information hierarchy and state transitions should change next.

## Relationship to ongoing work

- #242 and its child issues replace the production Conversation adapter while preserving the existing generic Runner, Application, Action, and Execution boundaries.
- The companion projection must consume those generic boundaries rather than inspect ACP or legacy adapter internals.
- #218/#225/#226 own the multi-workspace runtime proof and live validation. Companion work should reuse its workspace-binding directory rather than create another registry or receiver.
- The closed #217 canary is prior evidence that one Conversation can remain responsive while an Execution runs and later receive its terminal event.

## Deliberately unresolved until use

- Exact work-thread ordering within a workspace.
- Whether needs-attention work is a separate section or a visual treatment within in-progress work.
- Which safe title is most useful.
- Row density and which timestamps matter.
- How much Execution detail fits without becoming diagnostics.
- Popover size, scrolling, dismissal, and keyboard behavior.
- Whether clicking a row should open Slack or expand local detail.
- Which additional operator actions deserve later specification.
