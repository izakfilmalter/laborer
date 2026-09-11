# Diagnosing terminal typing latency

The useful measurement is **input offered → echo rendered**, with intermediate
timestamps. A successful `terminal.write` RPC only proves that the input request
completed. An output acknowledgement proves that the terminal surface parsed
output; neither proves that the browser painted it.

## T3 sync checked on 2026-09-11

Compared against freshly fetched T3 `origin/main` at
`211618fd9fe39d3dde01171a6856ce9f633571c9`.

Both repositories already pin Ghostty to
`9f62873bf195e4d8a762d768a1405a5f2f7b1697`. Both WASM assets are byte-identical,
so this update changes the JavaScript integration, not the Ghostty binary:

| Asset | SHA-256 |
| --- | --- |
| `ghostty-vt.wasm` | `51b016a6aa3c29ead71c7c8acf8c01d43b064bae19957a9c9f9e2bf469267629` |
| `ghostty-write-pty.wasm` | `75cb147e98ede3f85f3cd6236a30f6d12565b0b237e1d8db941f5f3e8ad3d903` |

Ported upstream changes:

- `cccd7e3c`: reuse grapheme allocations and scalar memory views, reduce style
  lookups, and fast-path single-codepoint cells during snapshots.
- `5eab021a`: skip rendering and cursor timers while hidden or zero-sized,
  retaining output parsing and terminal replies. Zero-size detection is automatic;
  explicit `setVisible()` is available to hosts.
- `83b865fe`: Ctrl+Insert copy.
- `d1eeb162`: Linux/BSD middle-click selection paste.

Laborer's terminal find, plain-click URLs, modifier-gated file paths, viewport
text reader, and host shortcuts are retained. T3's later link refactor was not
copied wholesale because it changes those semantics. Its retained-buffer rollover
optimization (`da7e46d0`) belongs to T3's host/transport architecture rather than
the vendored Ghostty surface.

### Snapshot optimization measurement

A differential benchmark instantiated separate copies of the real WASM with
baseline source from `213a4326` and the updated integration. Both used identical
warmups, alternating measurement order, a 120×40 mixed-style/grapheme grid, 120
full-grid samples, and 500 small-echo samples per variant.

| Parse + snapshot workload | Baseline median / p95 | Updated median / p95 |
| --- | ---: | ---: |
| Filled 120×40 grid | 5.99 / 6.50 ms | 3.45 / 3.95 ms |
| Small typed echo | 0.128 / 0.154 ms | 0.074 / 0.089 ms |

Four process runs showed similar results: full-grid medians of 5.99–6.11 ms
before and 3.44–3.49 ms after, approximately a 42% reduction. Baseline and updated
snapshots matched exactly after both workloads, including styling, emoji, and
combining graphemes. This benchmark excludes canvas rendering, transport, and
the application; it measures the upstream snapshot improvement only.

## Initial browser result

An isolated headless Chromium 151 run on macOS, using trusted keyboard events
for 180 ASCII characters with an 8 ms typing delay, produced:

| Measurement | p95 | Maximum |
| --- | ---: | ---: |
| Keyboard handler entry → encoded input | 0.1 ms | 0.6 ms |
| Synchronous parse and render scheduling | 0.1 ms | 0.2 ms |
| Encoded input → echo glyph canvas submission | 8.7 ms | 9.3 ms |

All 180 characters reached `onData` in order and received an echo-glyph
submission observation. No browser stalls of 50 ms or more were recorded. This
is a baseline for the updated surface, not a reproduction of the reported
intermittent in-application lag.

The scrollback case did reproduce a separate visibility issue: typing
`SCROLL_ECHO_42` while looking at history delivered and parsed the input promptly,
but the marker stayed outside the viewport until an explicit `scrollToBottom()`.
Current T3 has the same host behavior. This observation alone does not establish
that scrollback is the cause of the user's typing stalls.

Real-browser lifecycle checks also confirmed that both explicit hiding and
zero-sized containers suppress canvas drawing, retain parsed output, and render
the retained content after becoming visible again.

An isolated raw-PTY transport run with 200 requests at 60 requests/second and
the production-like serial input lane measured offered-input → output at
0.96 ms median, 5.61 ms p95, and 7.68 ms maximum. All 200 markers returned without
loss, duplication, reordering, RPC errors, or acknowledgement errors. This path
uses production terminal handlers and the manager but excludes the detached-host
proxy and the rest of the daemon; it cannot clear those boundaries of suspicion.

### Combined browser/PTY comparison

After validating the recorder's frame boundary and keeping screen reads out of
the per-cell drawing path, five runs used 180 characters at an 8 ms typing delay:

| Workload | Input → completed canvas frame p95 | Maximum |
| --- | ---: | ---: |
| Local Ghostty echo | 8.4 ms | 9.1 ms |
| Browser RPC → raw PTY echo | 31.4 ms | 35.3 ms |
| Browser RPC → full-grid TUI redraw | 39.3 ms | 65.4 ms |
| Browser RPC → prompt-only TUI redraw | 32.7 ms | 51.5 ms |
| Browser RPC → full-grid TUI with 60 FPS background redraws | 37.7 ms | 47.6 ms |

Each run verified all 180 inputs, and each had 180 frame-completion observations.
Raw mode checked exact returned bytes; TUI modes checked rendered input prefixes.
No browser stall of 50 ms or more was recorded. These are single-run comparisons
with scheduler variance, not a claim that background redraws improve latency.
They show measurable cost above local echo but do not reproduce the reported
intermittent disappearing-letter stall.

## Run the probes

From the repository root:

```sh
# Browser input, Ghostty parsing, and canvas submission with immediate local echo
bun run --cwd apps/web diagnose:terminal --count 10 --delay 8 --output ghostty-local.json

# Real Effect RPC codecs/handlers/stream, in a separate isolated process
bun run --cwd packages/terminal diagnostic:transport run --mode minimal > rpc-minimal.json

# Add the production terminal manager and a private PTY
bun run --cwd packages/terminal diagnostic:transport run --mode pty > rpc-pty.json

# Verify that a blocked server shows up in the measurements
bun run --cwd packages/terminal diagnostic:transport run --mode minimal --load-block-ms 100 --load-every-ms 500 > rpc-blocked.json
```

The browser command runs from `apps/web`, so its relative output path is resolved
there. Shell redirection for the transport commands writes to the current shell's
directory. Keep the JSON files together with a note about whether the same typing
felt delayed in Laborer at the time.

For interactive typing, run
`bun run --cwd apps/web dev:terminal-diagnostic` and open
<http://127.0.0.1:4179>. Export JSON after a problematic run. See the
[browser harness guide](../apps/web/diagnostics/README.md) and
[transport harness guide](../packages/terminal/diagnostics/README.md) for options
and the standalone RPC server contract.

### TUI workload

The reported symptom occurs frequently in TUIs such as OpenCode. Raw echo alone
does not exercise their redraw load. `packages/terminal/diagnostics/tui-fixture.mjs`
is an offline workload that accepts raw input, enters the alternate screen, and
redraws a styled grid and the input prompt for each input chunk. Frames are
wrapped in DEC synchronized-output sequences by default.

Spawn it in the diagnostic PTY using the browser harness's custom command:

```sh
node /absolute/path/to/laborer/packages/terminal/diagnostics/tui-fixture.mjs
```

Set `TUI_SYNC=0` in that command to compare without synchronized-output markers.
Set `TUI_REDRAW=prompt` to update just the input region after the initial frame,
keeping the same alternate screen and synchronization protocol.
Set `TUI_BACKGROUND_FPS=60` to add continual redraws while typing. These are
explicit workload controls, not production settings. The fixture handles plain
printable text, backspace, and Enter/Ctrl+U to clear; Ctrl+C exits. It does not
emulate OpenCode or negotiate its keyboard protocol.

For this workload, verify the rendered prompt rather than expecting output
bytes to equal input bytes: the output contains cursor movement, styling, and
whole-screen redraws. Keep raw-echo, TUI-redraw, and real-application captures
labelled separately.

For an automated run, start the PTY server in one terminal, then run from the
repository root in another:

```sh
bun run --cwd packages/terminal diagnostic:transport server --mode pty --port 2210
```

```sh
bun run --cwd apps/web diagnose:terminal \
  --rpc-url ws://127.0.0.1:2210/ws \
  --command "node '$PWD/packages/terminal/diagnostics/tui-fixture.mjs'" \
  --output ghostty-tui.json
```

For the next real-application capture, run the interactive diagnostic page and
use its **Command to launch** field for your usual OpenCode command,
including the project directory.
This runs the TUI through Ghostty and the isolated PTY service without the
Laborer application around it. Export JSON while the problem is visible, then
use **Disconnect RPC** to clean up the diagnostic terminal. A trace that fails
here narrows the next investigation to the TUI/renderer/transport path; a trace
that stays responsive while Laborer stalls calls for recording the full app's
shared daemon and renderer workload next.

### Real OpenCode in the isolated harness

`opencode2 <project>` was launched through the browser harness against the
isolated PTY server (production `TerminalManager`, in-process node-pty). Once
OpenCode's startup output went quiet, 44 keystrokes were typed at three rates:

| Typing interval | Keystroke → completed canvas frame (p50 / p95 / max) | RPC return p95 |
| --- | ---: | ---: |
| 60 ms | 16.1 / 24.2 / 26.5 ms | 8.2 ms |
| 40 ms | 16.2 / 24.1 / 25.1 ms | 7.9 ms |
| 25 ms | 15.9 / 23.0 / 25.6 ms | 8.5 ms |

Every keystroke was verified in OpenCode's rendered prompt, with no browser
stalls, while OpenCode emitted roughly 300 KB of redraw output. These short runs
did not build a backlog at 40 keys per second; they do not rule out the grouped
typing seen in the longer manual capture below.

A run typed **while OpenCode was still initializing** and saw about a second
without output. The prompt matcher later reported roughly 1.9 s delays, but the
sequence repeated and wrapped, making individual character attribution
ambiguous. This does not establish OpenCode startup as the cause of the user's
lag, or prove equivalent behavior in another terminal. The harness now waits
for a launched command's output to go quiet before measuring.

Not covered by these runs: the detached pty-host proxy hop (the isolated
server uses in-process node-pty), the daemon's other services under real
workspace load, and Laborer's own renderer and Electron shell. The running
daemon rejects the harness page's WebSocket Origin by design and is a different
build than this branch; attempted cross-build probes did not produce a valid
measurement. To measure the real backend, run the daemon from this branch's dev
flow with the diagnostic page's port allowed, or capture from inside Laborer.

### Harness lesson: never echo terminal replies

The first harness run against OpenCode crashed every Ghostty call with
"memory access out of bounds". The cause was the harness, not Ghostty: output
arrived before its RPC connection was assigned, so the local-echo branch wrote
Ghostty's query replies straight back into the terminal from inside the writer
callback. `CSI ? u` is answered with `CSI ? 0 u`, which is itself a query, so
the echo recursed `vt_write → reply → vt_write …` until the WASM stack overflowed
and poisoned the shared runtime. A bounded re-entrant write does not corrupt
memory (verified against HEAD and the updated core), so no product change was
warranted. A host must forward replies to the process, never to the surface;
the harness now queues replies produced during connection setup and forwards
them once the input lane exists.

### User capture: grouped typing, September 11

The manual `ghostty-latency-2026-09-11T14_47_32.324Z.json` capture contains 560
printable inputs over 18.9 seconds against the isolated PTY server on port 2210.
Two diagnostic bugs invalidated the headline interpretation: the keyboard FIFO
included nine characters typed into the command field, and the prefix matcher
stopped after input 70 when OpenCode wrapped its prompt inside a bordered box.
The reported 282 ms median keyboard-handler latency was therefore a mismatched
event correlation, not a measured delay in Ghostty. Matching the recorded key
sequence at the nine-event offset gives 0.1 ms median and 0.6 ms maximum for the
551 recoverable keydown-to-onData pairs.

Offline replay through the real WASM, reconstructing OpenCode's bordered prompt
across wrapping and the later clear, located all 560 printable inputs. At the
captured output-event times the reconstructed prompt had these delays from
input offer: median 18.6 ms, p95 36.8 ms, maximum 57.0 ms. There were 66 output
updates with two new characters and 11 with three. The serial input lane itself
added up to 27.7 ms. These are output-availability timings, not actual canvas or
display paint: the original capture only has verified canvas timings for the
first 70 characters. Lack of a ≥50 ms event-loop stall does not establish that
typing feels immediate.

The diagnostic now scopes key capture to the terminal, expires unmatched key
events, reports unverified sample counts, and records frame completion with
the latest attach-event index independently of prompt matching. Output records
retain full chunks within a total recording budget and explicitly flag
truncation. Unmeasured terminal replies no longer falsely mark measurements as
capped.

### Input-aware output batching

A controlled A/B with the offline full-redraw fixture at 60 background frames
per second, 36 characters at 8 ms intervals, isolated PTY and headless Chromium,
identified the PTY coalescing window as a contributor:

| Output policy | Completed-frame p50, two runs | Completed-frame p95, two runs |
| --- | --- | --- |
| Fixed 16 ms | 29.3 / 23.0 ms | 46.0 / 35.7 ms |
| Fixed 1 ms | 13.4 / 14.0 ms | 23.6 / 23.7 ms |
| Input-aware | 14.0 / 13.8 ms | 24.2 / 23.7 ms |

The previous leading-edge limiter only avoided latency when output was idle.
A continuously drawing TUI keeps the window open, adding a batching wait on
top of the application's render timer and the browser's animation frame.
`pty-direct.ts` now notifies the coalescer on input. For 100 ms after the latest
input, its window is capped at 1 ms, including shortening an already-open
background window. More input never postpones an earlier flush deadline.
Background output then returns to the configured power-profile window. Explicit
`TERMINAL_OUTPUT_COALESCE_MS` overrides still pin the window, allowing the same
A/B without changing code. This implementation also runs inside the detached
PTY host, though measurements here use only isolated hosts.

Regression tests reproduce the delayed fragmented response during continuous
output and cover deadline renewal, return to background batching and explicit
overrides. All measured fixture inputs were rendered correctly. Two pairs of
short, idle OpenCode runs at the same typing rate showed no consistent gain
(fixed p95 25.5 / 26.4 ms, adaptive 28.1 / 26.1 ms). This fixes a demonstrated
busy-output contributor; confirmation of the user's full subjective symptom
still requires a fresh manual run. It is not evidence that all remaining input,
TUI, compositor or display latency is resolved.

### Follow-up capture: September 11, 15:09 UTC

`ghostty-latency-2026-09-11T15_09_12.857Z.json` includes 355 measured printable
inputs, 340 complete attach events, and 258 canvas frames with no recording
truncation. Keyboard correlation is now correct (median 0.1 ms, max 0.4 ms).
The online prefix matcher still only verifies 67 inputs; the new frame timeline
allows offline attribution across wrapping and the later prompt clear.

Replaying at the recorded 151×29 grid and correlating the actual frame's attach
index recovered all 355 inputs. The prompt initially includes unmeasured `jkl`
typeahead; those glyphs must not be mistaken for later measured input. Rounded
results after accounting for that prefix:

| Stage | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Input offered → output available | 17.0 ms | 31.6 ms | 77.7 ms |
| Output available → canvas completed | 15.2 ms | 17.4 ms | 19.7 ms |
| Input offered → canvas completed | 30.7 ms | 45.0 ms | 81.0 ms |

Canvas execution itself took median 0.7 ms, p95 1.4 ms during typing. Grouped
updates already contained 107 characters at output arrival; drawing frames
grouped 230 characters. The first measured input waited behind startup input
in the serialized lane for 54.9 ms; subsequent long-tail examples combine about
20 ms input queueing, 18 ms sent-to-output, and 15 ms waiting to draw. No
event-loop stall ≥50 ms was recorded, which again does not imply smooth echo.

The previous automated environment used Playwright's Chrome 151, while the
manual captures use installed Chrome 152. Repeating the first 64 inputs' cadence
with installed Chrome 152 and native keyboard events reproduced the delay:
median 30.9 ms / p95 49.8 ms. A diagnostic-only immediate-render experiment on
the same workload measured median 21.6 ms / p95 32.8 ms, with all 64 characters
verified in both modes. These are short runs; their maxima include startup
outliers (168.8 ms vs 59.6 ms) and should not be treated as steady-state bounds.

The harness exposed this A/B through **Output drawing**, and the CLI can
select installed Chrome with `--browser-channel chrome`. At this stage the
production surface still used its existing frame scheduler. The next step was
a manual comparison of perceived echo under both modes: immediate submission
reduces a measured wait, but browser compositing and physical presentation are
not measured by these records.

### Confirmed improvement and production fix: September 11, 18:34 UTC

The user reported **“Feels better”** with immediate output drawing and supplied
`ghostty-latency-2026-09-11T18_34_22.181Z.json`. This capture is entirely in
immediate mode: 292 measured inputs, 285 complete attach events and 286 drawing
frames. Offline replay recovered all 292 characters, accounting for unmeasured
`jask` typeahead before the recorded sequence and subsequent prompt wrapping.

| Measurement | Previous manual capture | Immediate manual capture |
| --- | ---: | ---: |
| Input → completed drawing, median | 30.7 ms | 17.9 ms |
| Input → completed drawing, p95 | 45.0 ms | 30.3 ms |
| Output arrival → completed drawing, median | 15.2 ms | 0.7 ms |
| Output arrival → completed drawing, p95 | 17.4 ms | 1.2 ms |

Output-arrival latency stayed essentially the same (17.0 vs 17.1 ms median).
In the immediate capture, output-update and drawing-frame groupings are
identical: 216 single-character, 24 two-character, eight three-character and one
four-character update. The renderer adds no further grouping. These separate
manual runs are not a randomized benchmark, but the timing change and the user's
subjective confirmation agree with the controlled experiments.

`GhosttyTerminalSurface.write()` now submits parsed output synchronously through
`renderOutput()`. The existing renderer consumes any queued redraw, avoiding a
duplicate next-frame paint. Hidden and zero-sized surfaces still parse and reply
without drawing, and restoration repaints the preserved state. Cursor,
selection, theme and replay invalidations retain their existing scheduling.
Upstream PTY coalescing continues to bound background output work.

The diagnostic defaults to **Immediate output (current)** and uses that actual
production path. **Next animation frame (previous)** overrides only the private
output-scheduling seam for comparison. A fresh Chrome 152/OpenCode CLI comparison
after promotion verified every character: previous median/p95 25.1/32.5 ms,
production immediate 13.7/18.6 ms (36 characters, 25 ms typing interval).
Local echo, scrollback and hidden/zero-size lifecycle browser checks also pass.

Four real-WASM surface regression tests cover immediate output submission,
pending-frame cancellation, hidden query handling/restoration, and zero-size
restoration/disposal. The first two failed under the old scheduling. Full web
validation has 1,925 passing tests and the known unrelated `scrollbar-none`
assertion failure in `test/tab-bar-overflow.test.tsx`; typecheck and formatting
pass. The lasting lesson is to measure input-to-drawing with the user's browser
and native keyboard events: counting only ≥50 ms stalls misses an extra frame
of latency on almost every keystroke.

### Synchronized-output finding

The real-WASM protocol tests verify fragmented alternate-screen frames, DEC 2026
mode queries, final frame contents, and Kitty keyboard encoding. They also
characterize an embedder responsibility: `core.snapshot()` exposes partial
parser state while DEC 2026 is enabled. Both Laborer's and current T3's web
surfaces paint those snapshots without native Ghostty's synchronized-output
render gate.

Native Ghostty pairs that gate with a roughly one-second watchdog in its termio
thread. The WASM ABI supplies neither the native render loop nor that timer;
the test still sees mode 2026 enabled after 1.1 seconds, and resize resets it.
Adding a render gate alone would risk indefinitely withholding output when a
TUI never closes a frame. The current behavior can expose intermediate frames;
it has not been established as the cause of the reported typing stalls.

## Boundaries to measure

Laborer's terminal pane takes this path:

1. The browser delivers a keyboard or composition event to the Ghostty surface.
2. Ghostty encodes it and calls the pane's `onData` callback. Host navigation
   shortcuts can instead send through the pane's `beforeKey` callback.
3. `use-terminal-rpc.ts` queues input and sends one `terminal.write` RPC at a
   time. Each write waits for the preceding write's response.
4. The renderer protocol delivers the request to the daemon. Terminal calls
   share the daemon client/runtime with other application RPCs.
5. The PTY receives the input; its output returns through `terminal.attach`.
6. `terminal-attach-loop.ts` passes output to the mounted screen and acknowledges
   parsed output in batches.
7. Ghostty parses synchronously, then schedules its canvas rendering with
   `requestAnimationFrame`.

Measure input queue wait separately from RPC completion and output arrival.
Generate inputs on an independent schedule: waiting for each echo before
offering another input hides a backlog that a person typing would encounter.
Use ordered markers and check their contents, not just the number of callbacks.

## Isolation ladder

- **Local echo:** the real Ghostty surface immediately writes its encoded input
  back to itself. This exercises browser input, WASM parsing, and canvas drawing.
- **RPC echo:** send input through the real Effect WebSocket RPC codec and return
  it on the terminal attach stream. This adds transport and RPC scheduling.
- **PTY echo:** add an isolated real PTY and output coalescing. This adds process
  input/output to the same protocol.
- **Laborer under load:** compare against a running application with its usual
  workspaces and active terminals. The isolated baselines do not include daemon
  housekeeping, other RPC traffic, the full React tree, or Electron composition.

Keep renderer, transport, and server-load changes separate when comparing runs.
Record p50, p95, p99, maximum, missing/reordered inputs, frame gaps, and event-loop
stalls. Canvas draw completion is a render-submission measurement, not a physical
display-paint timestamp.

## Existing work to account for

Commit `c97c42ea` (PR #639) recorded daemon event-loop stalls up to 1.2 seconds
and moved process spawning to a worker, reduced watcher feedback, and made output
coalescing leading-edge. Those changes are present in this branch. Their earlier
measurements are historical evidence, not a measurement of the remaining bug.

Flow-control and liveness experiments must respect
[ADR 0002](adr/0002-flow-control-only-while-attached.md) and
[ADR 0003](adr/0003-advisory-liveness-explicit-terminal-lifecycle.md): detached
terminals keep running; attach resets stale acknowledgement debt; a latency
probe must not kill or replace a user's existing terminal.

## Reading a capture

- A long browser-event → encoded-input interval points to input handling or
  browser main-thread contention.
- A long offered → sent interval points to the serial input lane backing up.
- A long sent → output interval with fast local echo points below the renderer.
- Fast output arrival and parsing followed by a long render interval points to
  browser frame scheduling or rendering work.
- Timely parsing with no visible marker can also be a viewport problem: check
  whether the pane is scrolled above the live cursor.

Passing an isolated run narrows the investigation. It does not establish that
the intermittent in-application symptom is fixed. Preserve a capture from the
environment where the problem actually occurs before making that claim.
