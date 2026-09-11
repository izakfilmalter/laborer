# Terminal transport latency diagnostic

This harness measures the production Effect JSON/WebSocket RPC boundary using
the shared `TerminalRpcs` contract and production `TerminalRpcsLive` handlers.
It never connects to Laborer's registered detached PTY host.

`run` starts the server in a separate child process. This is load-bearing for
measurement: a blocked server must not also delay the client's offered-at
clock. It also guarantees that isolated PTY resources disappear after the run.

- `minimal` uses an in-memory echoing `TerminalManager` to isolate Effect RPC.
- `pty` uses the production `TerminalManager` and an isolated in-process
  `node-pty` (`stty raw -echo; cat`) to include PTY input/output, journaling,
  coalescing, attach streaming, and acknowledgements.

Each input carries a run ID and sequence number. Every sample records when it
was offered to the input lane, sent to RPC, returned by RPC, and observed on the
attach stream. The report summarizes offered-to-output, queueing,
sent-to-output, and RPC-return latency at p50/p95/p99/max, plus missing,
duplicate, reordered, failed-RPC/ack, and RPC-timeout counts. It also includes
the run ID, detected server mode/load configuration, and a bounded per-sample
timeline, so saved JSON is self-describing. Interrupting deadlines cover RPC
setup, spawn, writes, attach readiness, output waiting, and cleanup.

The default `serial` lane mirrors `use-terminal-rpc.ts`: only one
`terminal.write` RPC is in flight, and later offered input waits for its
response. `--lane concurrent` is a transport-only baseline; it does **not**
model the production frontend lane.

```sh
# One-command isolated runs (ephemeral port)
bun run --cwd packages/terminal diagnostic:transport run --mode minimal
bun run --cwd packages/terminal diagnostic:transport run --mode pty

# Change sample count and request rate (requests/second; 0 sends immediately)
bun run --cwd packages/terminal diagnostic:transport run --mode pty --samples 500 --rate 60 --timeout-ms 10000

# Explicit transport-only baseline (multiple writes may be in flight)
bun run --cwd packages/terminal diagnostic:transport run --mode minimal --lane concurrent --rate 60

# Deliberately block the diagnostic server event loop to verify sensitivity
bun run --cwd packages/terminal diagnostic:transport run --mode minimal --load-block-ms 100 --load-every-ms 500

# Standalone server for a browser/frontend harness
bun run --cwd packages/terminal diagnostic:transport server --mode pty --port 2210
# Then connect to ws://127.0.0.1:2210/ws. Health: http://127.0.0.1:2210/health

# Benchmark an already-running diagnostic server
bun run --cwd packages/terminal diagnostic:transport bench --url ws://127.0.0.1:2210/ws
```

## Browser integration contract

- WebSocket endpoint: `ws://127.0.0.1:<port>/ws`.
- Serialization: Effect `RpcSerialization.layerJson`.
- RPC group and event schemas: shared `TerminalRpcs` from
  `@laborer/shared/rpc` (not a diagnostics-only protocol).
- The server starts with no terminals. Call `terminal.spawn` and retain its
  returned `id`; there is no fixed default terminal ID.
- The bundled benchmark uses workspace ID `transport-diagnostic`, but the
  server treats `workspaceId` as opaque and a browser may use any string.
- Call `terminal.attach` with the returned terminal ID and a caller-owned,
  unique `leaseId`. The bundled benchmark generates both its terminal ID and
  lease ID from the report's `runId`. The stream emits the normal `Snapshot`, `Meta`,
  `ReplayComplete`, and `Delta` event shapes.
- Send input through `terminal.write`. Acknowledge rendered `Delta.cursor`
  values with `terminal.ack` using the same terminal ID and lease ID.
- `minimal` echoes each write into a `Delta` without a PTY. `pty` honors the
  spawn command through the real manager and in-process node-pty. For a
  keystroke-at-a-time echo target, spawn `stty raw -echo; cat`; canonical mode
  (`stty -echo; cat`) buffers input until newline and is unsuitable for browser
  typing measurements. Raw mode also disables output newline translation, so
  consumers must not expect `ONLCR` (`\n` becoming `\r\n`).

Do not treat one run as a product latency claim. Compare repeated runs and keep
the mode, request rate, load injection, machine power state, and sample count
with the result.
