# Terminal Performance Optimization — Product Requirements Document

## Problem Statement

Laborer's terminal has noticeable lag. The entire data path from PTY output to the user's screen involves six unnecessary transformations: the PTY host base64-encodes every output chunk, wraps it in JSON, pipes it to the server, the server JSON-parses it, base64-decodes it, commits it as an individual LiveStore event, which is stored in SQLite, synced over WebSocket as part of the LiveStore sync protocol, stored again in the client's OPFS SQLite, and finally written to xterm.js — one event at a time, with no batching, coalescing, or flow control at any layer.

This architecture has several concrete problems:

1. **Redundant base64 encoding.** PTY output is already UTF-8 text (from node-pty's `onData`). It gets base64-encoded in the PTY host, inflating data by 33%, then base64-decoded in the terminal manager. JSON can transport UTF-8 strings directly with proper escaping.

2. **No data coalescing.** Every `onData` callback from node-pty (which can fire for as little as a single character during interactive typing) produces a separate IPC message, LiveStore event, sync event, and xterm.js write call. A build log or `cat` of a large file generates thousands of tiny events per second.

3. **No flow control.** Fast-producing processes (e.g., `cat /dev/urandom | base64`, or a verbose build) flood the entire pipeline without bound. There is no mechanism to pause the PTY when the consumer can't keep up, which causes unbounded memory growth in pipe buffers and event queues.

4. **LiveStore overhead on the hot path.** Every output chunk is committed as a `v1.TerminalOutput` synced event, stored in the server's SQLite eventlog, broadcast to all sync subscribers, transmitted over the LiveStore WebSocket sync protocol (with its own JSON serialization layer), and stored in the client's OPFS SQLite. This is heavyweight machinery for ephemeral streaming data.

5. **O(n²) string buffer operations.** Both the PTY host's stdin reader and the server's stdout reader use `buffer += chunk` followed by repeated `.slice()` calls to extract lines. Under high throughput this creates significant garbage collection pressure.

VS Code solves all of these problems in their PTY host architecture: raw string transport (no base64), 5ms data coalescing, character-count-based pause/resume flow control (100K high watermark, 5K low watermark), and process isolation. Laborer already has the process isolation; this PRD adds the performance layer.

## Solution

Replace the terminal data path with a dedicated WebSocket channel that bypasses LiveStore entirely for streaming output. Terminal output flows directly from the PTY host through the server to the client over raw WebSocket text frames — no base64, no JSON wrapping, no LiveStore events, no sync protocol overhead.

The PTY host coalesces rapid output chunks into batched messages using a 5ms timer (matching VS Code). A character-count-based flow control system prevents unbounded buffering by pausing the PTY when the client falls behind and resuming when it catches up. The server maintains a 1MB ring buffer per terminal for scrollback, so reconnecting clients (page reload) get recent output without needing LiveStore event replay.

Terminal lifecycle events (spawned, stopped, killed) remain in LiveStore since they are infrequent, structured state that the UI needs regardless of WebSocket connection state.

## User Stories

1. As a developer, I want keystrokes to appear in the terminal with imperceptible latency (under 16ms round-trip for local usage), so that the terminal feels as responsive as a native terminal emulator.
2. As a developer, I want to run `cat` on a large file and have the terminal remain responsive, so that high-throughput output does not freeze the UI or exhaust server memory.
3. As a developer, I want to run a verbose build (e.g., `cargo build`, `npm run build`) and see output streaming smoothly, so that I can monitor build progress in real time.
4. As a developer, I want to reload the page and see recent terminal output, so that I don't lose context when navigating away and back.
5. As a developer, I want to run TUI programs (vim, htop, top) and have them render correctly, so that full-screen terminal applications work properly through the web terminal.
6. As a developer, I want the terminal to handle binary output from programs without corruption, so that escape sequences, cursor positioning, and Unicode render correctly.
7. As a developer, I want to open multiple terminals simultaneously without them interfering with each other's performance, so that I can run builds, tests, and shells in parallel.
8. As a developer, I want the server to not run out of memory when a process produces output faster than the client can consume it, so that fast-producing commands don't crash the server.
9. As a developer, I want the terminal to work correctly when I disconnect and reconnect (e.g., laptop sleep/wake, network change), so that I can resume my terminal session.
10. As a developer, I want terminal resize to take effect immediately and flush any buffered output, so that full-screen programs reflow correctly.
11. As a developer, I want the terminal data path to not interfere with LiveStore sync performance, so that other features (workspace state, UI state) remain responsive while terminals are producing output.
12. As a developer, I want terminal lifecycle events (spawn, stop, kill) to be reflected in the UI reliably, so that I can see which terminals are running and which have stopped.
13. As a developer, I want the `terminal.write` RPC to continue working for programmatic terminal input (e.g., from agent automation), so that non-interactive callers aren't forced to use WebSockets.
14. As a developer, I want the `terminal.resize` RPC to continue working, so that resize is a structured command rather than an ambiguous raw message.

## 'Polishing' Requirements

1. **Keystroke latency.** Measure keystroke-to-echo round-trip time. Target: under 16ms for local usage (one frame at 60fps).
2. **Throughput.** Measure sustained output throughput with `cat` of a 10MB file. The terminal should complete without freezing the UI or causing OOM.
3. **Output fidelity.** Verify colors, Unicode, cursor positioning, and binary data from TUI programs (htop, vim, less) render correctly through the new data path.
4. **Reconnection.** Verify that reloading the page reconnects to the terminal WebSocket and displays the scrollback buffer contents.
5. **Flow control activation.** Verify that the PTY is actually paused when the client falls behind (measurable by observing the pause/resume transitions in PTY host debug logs during a `cat /dev/urandom | base64` stress test).
6. **Memory stability.** Run a terminal producing continuous output for 5 minutes and verify server RSS does not grow unboundedly. The ring buffer should cap memory usage.
7. **Multi-terminal isolation.** Open 4+ terminals, run output-heavy commands in one, and verify the others remain responsive.
8. **Graceful degradation.** If the WebSocket connection drops, verify the terminal status is reflected correctly in the UI and the PTY host pauses (rather than buffering unboundedly).
9. **Backward compatibility.** Verify that `terminal.write` RPC still works for programmatic input, and `terminal.resize` RPC still works for resize.
10. **LiveStore sync stability.** Verify that removing `terminalOutput` events from LiveStore does not break sync initialization or other event replay.

## Implementation Decisions

### Remove Base64 Encoding from IPC

The PTY host currently base64-encodes every output chunk before wrapping it in JSON. Since node-pty's `onData` produces UTF-8 strings and JSON natively supports UTF-8 (with escaping for control characters), the base64 step is unnecessary. The `data` field in IPC `data` events changes from base64-encoded to raw UTF-8 string. The terminal manager removes its corresponding `Buffer.from(base64Data, "base64").toString("utf-8")` decode step. JSON's built-in escaping handles the control characters and escape sequences that terminal output contains.

### Data Coalescing in the PTY Host

Add a 5ms coalescing timer per PTY instance, matching VS Code's `TerminalDataBufferer`. When `pty.onData` fires:

- If no buffer exists for that PTY, create one (an array of strings) and start a 5ms `setTimeout`.
- If a buffer already exists, push the data onto it (the timer is already running).
- When the timer fires, join all buffered strings, emit a single `data` event, and delete the buffer.

This reduces the number of IPC messages, JSON serializations, and downstream operations by an order of magnitude for burst output. For interactive typing (single characters arriving > 5ms apart), the behavior is unchanged — each character still gets its own event after a 5ms delay, which is imperceptible.

A resize command flushes any pending buffer for that PTY immediately (matching VS Code), ensuring output is associated with the correct terminal dimensions.

### Character-Count Flow Control

Implement VS Code's proven flow control model with three constants:

- **HighWatermarkChars = 100,000**: When unacknowledged characters exceed this, pause the PTY via `pty.pause()`.
- **LowWatermarkChars = 5,000**: When unacknowledged characters drop below this, resume the PTY via `pty.resume()`.
- **CharCountAckSize = 5,000**: The client sends an `ack` message for every 5,000 characters it processes.

The flow:
1. PTY host tracks `unacknowledgedCharCount` per PTY. Each `data` event increases it by the character count of the emitted data.
2. When `unacknowledgedCharCount > HighWatermarkChars`, the PTY host calls `pty.pause()` which stops reading from the PTY file descriptor. The OS kernel then applies backpressure to the producing process via the pipe buffer.
3. The web client counts characters received from the WebSocket and sends an `ack` text frame (JSON: `{"type":"ack","chars":<count>}`) for every `CharCountAckSize` characters processed.
4. The server forwards the ack through `PtyHostClient` to the PTY host.
5. The PTY host decrements `unacknowledgedCharCount` and resumes the PTY when it drops below `LowWatermarkChars`.

A new IPC command `{ type: "ack", id, chars }` is added to the PTY host protocol.

### Server-Side Ring Buffer for Scrollback

Each active terminal gets a ring buffer (circular buffer) in the terminal manager that stores the last 1MB of output. The buffer is a `Uint8Array` with a write cursor that wraps around when full.

When a WebSocket client connects, the server sends the ring buffer contents before streaming live output. This provides seamless reconnection (page reload) without LiveStore event replay. When the terminal exits or is killed, the ring buffer is retained until the terminal is explicitly removed, so clients can still see the output of completed terminals.

### Dedicated Terminal WebSocket Endpoint

A new HTTP route at `GET /terminal?id=<terminalId>` upgrades to a WebSocket connection. The protocol is:

**Client to Server (text frames):**
- Raw terminal input (keystrokes): any text frame that does not parse as a JSON control message is forwarded to the PTY as input.
- Ack messages: `{"type":"ack","chars":<number>}` — flow control acknowledgement.

**Server to Client (text frames):**
- Raw terminal output: UTF-8 text from the PTY, forwarded as-is.

**Connection lifecycle:**
1. Client connects with `?id=<terminalId>`.
2. Server validates the terminal exists and is running.
3. Server sends the ring buffer contents (scrollback) as one or more text frames.
4. Server subscribes to live output from the terminal manager and forwards it as text frames.
5. When the client sends text, the server forwards it to the PTY as input via `PtyHostClient.write()`.
6. When the client disconnects, the server unsubscribes from output. Flow control ack state is reset (the PTY is resumed if paused, and `unacknowledgedCharCount` is cleared for that client) to prevent the PTY from getting stuck in a paused state.
7. When the terminal exits, the server sends the final output and closes the WebSocket with a 1000 (normal closure) status.

The `terminal.write` RPC continues to work alongside the WebSocket for programmatic input from non-WebSocket callers (e.g., agent automation). `terminal.resize` remains an RPC call since it is a structured command, not a stream.

The Vite dev proxy in `apps/web/vite.config.ts` is updated to route `/terminal` WebSocket connections to the backend (similar to the existing `/rpc` proxy).

### Web Client Terminal Pane Update

The terminal pane component replaces its LiveStore `store.events()` subscription with a WebSocket connection:

1. On mount (when a terminal ID is available), open a WebSocket to `/terminal?id=<terminalId>`.
2. On message: write the data directly to xterm.js via `terminal.write(event.data)`.
3. On keypress: send the keystroke as a WebSocket text frame (replaces `terminal.write` RPC call).
4. Track characters received and send ack messages every 5,000 characters for flow control.
5. On unmount: close the WebSocket cleanly.
6. On WebSocket error/close: display a disconnection indicator; attempt reconnection with exponential backoff.

### LiveStore Schema Changes

The `terminalOutput` event is no longer committed on the server data path. It can be removed from the schema or kept as deprecated for backward compatibility with any existing eventlog data. Terminal lifecycle events (`terminalSpawned`, `terminalStatusChanged`, `terminalKilled`, `terminalRemoved`) remain as `Events.synced()` and continue to be committed to LiveStore.

### IPC Protocol Changes

The PTY host IPC protocol is updated:

**New command:**
- `{ type: "ack", id, chars }` — Acknowledge processing of `chars` characters for terminal `id`.

**Changed event:**
- `{ type: "data", id, data }` — The `data` field changes from base64-encoded to raw UTF-8 string.

**New event:**
- `{ type: "paused", id }` — Emitted when a PTY is paused due to flow control (for debug observability).
- `{ type: "resumed", id }` — Emitted when a PTY is resumed after flow control (for debug observability).

### Buffer Optimization

Both the PTY host's stdin line reader and the PtyHostClient's stdout line reader replace their `buffer += chunk` string concatenation with an array-based accumulator pattern:

- Incoming chunks are pushed onto an array.
- When scanning for newlines, only the last chunk needs to be searched (or the joined result if a newline spans chunks).
- On drain, the array is joined once and the remainder becomes the new single-element array.

This eliminates the O(n²) string copying behavior under high throughput.

### Layer and Dependency Changes

The dependency graph becomes:

```
Web Client
  ├── LiveStore (terminal status events: spawned/stopped/killed)
  └── WebSocket /terminal (streaming I/O + flow control acks)
        └── TerminalManager (ring buffer, subscriber management)
              └── PtyHostClient (IPC: commands + ack forwarding)
                    └── PTY Host child process (coalescing, flow control, node-pty)
```

No changes to the Effect layer composition are needed — the WebSocket endpoint is a new HTTP route handler, not an Effect service. The `PtyHostClient` gains an `ack()` method. The `TerminalManager` gains methods for subscribing/unsubscribing WebSocket consumers and accessing the ring buffer.

## Testing Decisions

**What makes a good test:** Tests verify external behavior through the public interface of each module. They do not test implementation details or internal state. For PTY-related tests, we accept that they interact with the OS (spawning real shell processes) since that is the behavior under test. Tests should be deterministic and clean up spawned processes.

### PTY Host Integration Tests (coalescing + flow control)

Extend the existing `packages/server/test/pty-host.test.ts` test suite. Send JSON commands via stdin, read JSON events from stdout. Verify:

- Data events contain raw UTF-8 strings (not base64).
- Rapid output from a command like `seq 1 1000` produces fewer data events than there are output lines (proving coalescing is working).
- The `ack` command decrements the unacknowledged char count (observable via debug output or by verifying that a paused PTY resumes after acks).
- A PTY producing output faster than the ack rate eventually gets paused (observable by the output rate plateauing or by a `paused` event).
- Resize flushes pending coalesced data immediately.

### Ring Buffer Unit Tests

Test the ring buffer data structure in isolation:

- Writing less than capacity returns the written data on read.
- Writing more than capacity wraps correctly and returns only the last `capacity` bytes.
- Reading from an empty buffer returns empty.
- Sequential writes and reads produce correct results.
- Edge cases: writing exactly capacity, writing zero bytes.

### Terminal WebSocket Endpoint Integration Tests

Test the WebSocket endpoint with a real PTY host and terminal manager:

- Connecting to a valid terminal ID succeeds and receives scrollback + live output.
- Connecting to a nonexistent terminal ID receives an error and the WebSocket closes.
- Sending text frames forwards input to the PTY (verifiable by echo).
- Sending ack frames is accepted without error.
- Disconnecting does not crash the terminal or leak resources.
- The terminal can be reconnected after disconnect (fresh scrollback is sent).

### End-to-End Data Path Tests

Test the full pipeline from PTY to a mock WebSocket client:

- Spawn a terminal, connect via WebSocket, send a command, verify the output arrives.
- Verify output fidelity: send a command that produces escape sequences (colors), verify they arrive unchanged.
- Verify flow control end-to-end: produce fast output, observe that output rate is bounded, send acks, observe that output resumes.

### Prior Art

The existing test suite uses vitest with `@effect/vitest` for Effect services. The PTY host tests in `packages/server/test/pty-host.test.ts` and `packages/server/test/terminal-manager.test.ts` provide patterns for spawning real PTY processes and asserting on their output.

## Out of Scope

- **Terminal multiplexing protocol.** Each terminal gets its own WebSocket connection. Multiplexing multiple terminals over a single WebSocket (with framing/channel IDs) is not needed at this scale and adds protocol complexity.
- **Compression.** WebSocket per-message deflate or custom compression of terminal output. The coalescing and removal of base64/JSON overhead already dramatically reduces bandwidth. Compression can be added later if needed for remote (non-localhost) usage.
- **Terminal recording/playback.** Recording terminal sessions for later replay (like asciinema) is a separate feature. The ring buffer provides reconnection scrollback, not persistent recording.
- **Shared terminal viewing.** Multiple clients watching the same terminal simultaneously is architecturally supported (multiple WebSocket subscribers) but the UI for sharing terminals is not part of this PRD.
- **Custom flow control constants.** The watermark values (100K/5K/5K) are hardcoded, matching VS Code's proven defaults. Making them configurable is unnecessary complexity.
- **Heartbeat/keepalive for WebSocket.** The WebSocket protocol has built-in ping/pong. Adding application-level heartbeats is a future enhancement if connection detection proves insufficient.
- **PTY Host auto-restart.** If the PTY host crashes, terminals are marked as stopped (existing behavior from the previous PRD). Auto-restarting the PTY host is out of scope.
- **Changes to terminal spawn/kill/resize RPC.** These existing RPCs continue to work unchanged. Only the streaming data path changes.

## Further Notes

### Why a Separate WebSocket Instead of LiveStore

LiveStore is designed for structured, persistent application state that needs to be synchronized between server and client. Terminal output is ephemeral, high-volume streaming data that is consumed once and discarded. Routing it through LiveStore imposes five layers of overhead that add no value: server SQLite write, sync protocol serialization, WebSocket JSON framing, client SQLite write, and event replay on reconnection.

A dedicated WebSocket with raw text frames eliminates all five layers. The data goes from the PTY host IPC pipe directly to the WebSocket — two hops instead of seven. The ring buffer provides the reconnection story that LiveStore's event replay previously (poorly) served.

### Why Character-Count Flow Control Instead of Byte-Count

VS Code uses character count, not byte count, for flow control. This is deliberate: xterm.js processes characters, not bytes. A character-count watermark correlates with the actual rendering workload. Unicode characters that take multiple bytes still count as one character from the terminal's perspective.

### Coalescing Timer Interaction with Flow Control

When the PTY is paused due to flow control, the coalescing timer may still fire for any data that was buffered before the pause. This is correct — the timer flushes data that has already been read from the PTY. The flow control prevents new data from being read, but doesn't suppress already-buffered data.

### Relationship to the PTY Host PRD

This PRD builds on top of the completed PTY Host process isolation architecture (PRD-pty-host.md). The PTY host script, PtyHostClient service, and TerminalManager service are all modified but their fundamental architecture (isolated child process, IPC protocol, Effect service layers) remains unchanged. The public API surface of TerminalManager changes only in its internal data callback behavior — all RPC handlers continue to work.
