# Liveness signals are advisory; only explicit events end a terminal

Nearly every macOS sleep/wake cycle destroyed live agent sessions through a chain of well-intentioned watchdogs: the main-process lifecycle heartbeat (15s timeout, 5s clock-jump tolerance) killed the terminal utility process on a missed beat — macOS DarkWake emits no `suspend`/`resume`, so power events couldn't save it — then the renderer respawned replacement terminals without their original command, and the orphan grace reaper killed the faithfully-restored originals 60s later because nobody had claimed them. We decided that no liveness heuristic (heartbeat silence, subscriber count, pong timeout) may ever destroy the terminal service or a terminal. Destruction requires an explicit event: a kill RPC, PTY exit, actual process exit, or user action.

## Why

The cost asymmetry is extreme. A false-positive kill destroys irreplaceable state (a live agent mid-task) and was happening daily; a true-positive hang — rare in practice — merely leaves terminals frozen, which the UI can surface and the user can resolve with one click. VS Code reached the same conclusion for its pty host: missed heartbeats only ever fire `onPtyHostUnresponsive` (a status-bar warning with a manual-restart affordance), and its `SecondWaitMultiplier` constant exists, per its own comment, "to avoid informing the user incorrectly when waking the computer up from sleep." This is also the sibling of ADR 0002: flow control must never detect client death, and liveness heuristics must never decree server death.

## The decisions

1. **Heartbeat is status-only for the terminal service.** Silence past a two-stage awake-time threshold flips the Terminal status pill to "unresponsive" with a manual restart action; the next beat received self-heals it. The lifecycle monitor restarts the terminal service only on actual process exit (bounded retries) or user request. Stateless sidecars (file-watcher, mcp) keep kill-and-restart on heartbeat timeout.
2. **Adoption before respawn.** After a terminal-service restart, the renderer must not respawn anything until a `terminal.list` has succeeded against the restarted (healthy) service — the restored terminals carry their original IDs and are re-attached, not replaced. Respawn is reserved for IDs confirmed absent from a successful post-restart list.
3. **Spawn intent is persisted with the layout.** Terminal layout leaves keep the command they were created with (previously `'agent'` pane types were erased to `'terminal'` before persistence), so a genuinely-dead terminal respawns as what it was — an agent pane comes back as a fresh agent CLI, never silently as a plain shell.
4. **The grace reaper only kills never-claimed fresh spawns.** The 60s orphan timer remains solely as a leak guard for terminals spawned by a client that vanished before first subscribe. Disconnect-based reaping is removed (it contradicted the detached-terminal contract in CONTEXT.md), and restored terminals are never subject to grace — they proved their ownership in a previous life.
5. **Destructive timers count awake time, not wall-clock time.** Any timer whose expiry destroys state or triggers recovery (the orphan leak guard, the renderer pong timeout, the sidecar heartbeat timeouts) uses a shared process-time scheduler in the style of VS Code's `ProcessTimeRunOnceScheduler`: a coarse interval countdown that does not advance during OS sleep. The tick-gap sleep-detection heuristic and the heartbeat clock-jump tolerance are deleted — they were probabilistic compensation for wall-clock timers, which no longer exist.

## Consequences

- A truly hung terminal service stays hung until the user restarts it from the status pill. This is deliberate: visible-and-frozen beats invisible-and-destroyed.
- "Terminal service unavailable" error surfaces in panes are reserved for confirmed death (actual process exit), never for heartbeat silence.
- Manual restart remains low-cost: graceful SIGTERM persists sessions, restoration keeps IDs, and adoption re-attaches panes.
- Leak protection narrows: a terminal that was claimed once and later abandoned (without a pane close, which kills explicitly) lives until app shutdown. Detached terminals are first-class in this domain, so that is a feature, not a leak.
