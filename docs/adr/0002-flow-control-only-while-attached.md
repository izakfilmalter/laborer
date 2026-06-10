# PTY flow control is active only while a data channel is attached, and resets on every attach

Laborer copied VS Code's terminal flow control (count PTY output chars, `pty.pause()` above a 100k high watermark, resume when client acks bring the count below 5k) but diverges in two deliberate ways: the counter only runs while at least one data-channel consumer is attached, and every attach zeroes the counter and force-resumes a paused PTY. Consumer attach/detach is refcounted in `pty-direct.ts`; the data channel registers on attach and deregisters when its port closes.

## Why

VS Code intentionally lets a detached terminal pause at the high watermark — the pause is OS-level backpressure that bounds memory, and a detached VS Code terminal is an idle shell, so blocking it costs nothing. Laborer's detached terminals are autonomous agents that must keep making progress while no pane is watching: a paused PTY fills the ~64KB kernel buffer and then blocks the agent's stdout writes, stalling the agent itself mid-task. So while unwatched, Laborer terminals always flow; memory stays bounded by the headless xterm mirror, which is the snapshot store anyway.

The reset-on-attach rule is VS Code's own (`clearUnacknowledgedChars()` on every `triggerReplay()`): ack debt belongs to one client connection and must never survive a reconnect. Laborer originally tried the inverse — reconciling debt on *disconnect* — and it caused permanently frozen terminals: MessagePorts can die without the server noticing, the disconnect cleanup never ran, the stale debt kept the PTY paused, and no amount of reattaching could revive it (resume required acks below the low watermark that no client could ever satisfy).

## Consequences

- A terminal can never be permanently frozen by flow control: opening (or remounting) its pane resets the counter and resumes the PTY.
- Backpressure still protects a live renderer that genuinely falls behind on a firehose of output.
- The accounting is deliberately loose with multiple panes on one terminal: a second pane attaching forgives debt owed to the first. VS Code accepts the same looseness; transiently exceeding the watermark is far cheaper than a wedged PTY.
- Flow control must never be the mechanism for detecting client death; transport-level close detection (MessagePort `close` events) handles channel lifetime, and the worst case if close detection fails is bounded by reset-on-next-attach.
