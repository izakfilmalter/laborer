# Ghostty browser latency diagnostic

This standalone Vite page mounts the real `GhosttyTerminalSurface` without
starting Laborer. In the default mode, keyboard output from the surface's real
`onData` callback is immediately written back to the same surface, isolating
keyboard encoding, Ghostty parsing, and browser canvas submission from RPC and
PTY transport. Optional RPC mode connects only to the isolated terminal
diagnostic server.

It loads the same Ghostty WASM, bundled Symbols Nerd Font, terminal font stack,
font size, and theme as the production terminal pane. No vendored or production
surface code is modified.

## Automated Chromium baseline

From `apps/web`:

```sh
bun scripts/terminal-latency.mjs --count 10 --delay 8 --output ghostty-latency.json
```

The script starts only the diagnostic Vite server, types through Playwright's
Chromium keyboard API (trusted browser events), runs a scrolled-back visibility
case and hidden/zero-sized lifecycle cases, prints a summary, and writes the
full JSON reports. Useful options are `--sequence`, `--count`, `--delay`,
`--port`, and `--output`.

The CLI writes its report before exiting nonzero when input is missing, RPC
output or acknowledgements fail, or a local lifecycle invariant fails. It has no
default latency threshold because scheduler timing is environment-sensitive.

## Isolated RPC and PTY mode

Start the backend diagnostic server from the repository root in another terminal:

```sh
bun run --cwd packages/terminal diagnostic:transport server --mode pty --port 2210
```

Then run the browser path:

```sh
cd apps/web
bun scripts/terminal-latency.mjs \
  --rpc-url ws://127.0.0.1:2210/ws \
  --terminal-id browser-latency-run \
  --output ghostty-rpc-latency.json
```

The terminal ID is optional. The adapter reuses it when it exists or spawns it
with `stty raw -echo; cat`, attaches, waits for replay, and verifies a warm-up
echo before accepting measured input. It uses the shared `TerminalRpcs`
contract and Effect JSON/WebSocket RPC. Writes pass through a 64 KiB bounded,
serialized lane matching production ordering. Reports include offer, send, RPC
return, attach output, snapshot/delta/reset, and acknowledgement timestamps,
plus queueing and transport percentile summaries.
RPC mode deliberately skips local scrollback and lifecycle cases.

For an ANSI full-grid redraw fixture, pass an isolated command when spawning a
fresh terminal ID:

```sh
bun scripts/terminal-latency.mjs \
  --rpc-url ws://127.0.0.1:2210/ws \
  --command "node /absolute/path/packages/terminal/diagnostics/tui-fixture.mjs" \
  --output ghostty-tui-latency.json
```

Custom-command mode records raw ANSI attach batches but does not compare those
bytes to keyboard input. It instead marks input observed when the real Ghostty
viewport contains the corresponding input prefix. Raw-cat mode retains strict
byte-for-byte output verification. Custom commands are not polluted with a
warm-up token: their first nonempty snapshot or delta is the readiness signal,
after which the harness waits (up to 15 s) for output to stay quiet for 750 ms
so a program's startup backlog is not measured as input latency. Terminal
replies, focus reports and mouse tracking that the program requests are
forwarded unmeasured in this mode; only printable input is verified against the
viewport. Replies produced before the RPC connection is assigned are queued and
delivered once it exists — they must never be written back into the surface,
because a query answered with another query would recurse inside the WASM
parser.

Manual captures record only terminal key events; typing in the command or URL
fields is excluded. `summary.unverifiedFrameSamples` reports inputs the prompt
matcher could not verify (for example after editing or wrapping inside a TUI's
bordered text box). Its latency percentiles cover only verified samples.
`canvasFrames` records each drawing frame's start/completion times and the
latest `rpc.attachEvents` index, even when prompt matching fails. Together with
`environment.terminalGrid`, this allows offline replay to correlate output with
drawn frames. Frame/event recording is bounded; `canvasFramesCapped` and each
event's `dataTruncated` flag identify incomplete captures. These are canvas
submission timings, not measurements of physical display paint.

## Compare output scheduling

The **Output drawing (A/B)** selector defaults to **Immediate output (current)**
and can restore **Next animation frame (previous)**. It takes effect on the next
output without restarting the process. Each sample/frame records the selected
mode so switching during a manual capture is visible in the JSON. Immediate
mode uses the production surface's output path; the previous policy is restored
only inside the diagnostic for comparisons. Lower canvas-submission latency
alone does not establish lower physical display latency. `parseAndScheduleMs`
includes synchronous drawing in immediate mode.

The CLI accepts `--render-output frame|immediate` and
`--browser-channel chromium|chrome`. `chromium` uses Playwright's bundled
browser; `chrome` uses the installed Google Chrome. Match the manual capture's
browser version when comparing results. For example, add
`--browser-channel chrome --render-output immediate` to an RPC diagnostic run.
TUI input-to-output summaries therefore end at a viewport observation during
canvas submission, while raw-cat summaries end at attach output arrival. Use
the frame-completion summary to compare both workloads at the same boundary.

## Manual use

From `apps/web`:

```sh
bunx vite --config diagnostics/vite.config.ts
```

Open <http://127.0.0.1:4179>, click the terminal, and type. “Run automatic
input” dispatches synthetic keyboard events for a repeatable in-page run;
Playwright is preferred when trusted events matter. Export JSON downloads all
bounded per-keystroke timings and stall records.

To try the actual TUI outside Laborer, start the diagnostic PTY server, enter its
WebSocket URL and your usual OpenCode command (including the project directory)
in **Command to launch**, leave Terminal ID
empty, and click **Connect RPC**. Type manually and export JSON. Automatic prompt
verification is intended for the printable-input fixture: arbitrary TUIs may
negotiate keyboard encodings, transform input, or hide parts of their prompt.
**Disconnect RPC** removes the terminal created by this page and returns to local
echo. Automated runs disconnect before closing the browser. Stop the diagnostic
server to clean up terminals left by abruptly closed browser tabs.

With **Command to launch** blank, the terminal runs raw `cat`, not a shell:
typing `opencode2` into that terminal only echoes the text. Enter it in the
command field above the terminal and reconnect to start the process. Generated
terminal IDs stay out of the attach field so launching another command creates
a fresh process.

## What the timestamps mean

- `inputToOnDataMs`: capturing `keydown` to the real surface's `onData`.
- `onDataToEchoMs`: `onData` to the matching `surface.write()` in local or raw
  RPC echo mode. TUI redraws do not have a one-to-one byte echo, so this is omitted.
- `parseAndScheduleMs`: synchronous `surface.write()` duration. This includes
  Ghostty parsing and scheduling, not rendering.
- `onDataToCanvasSubmissionMs`: `onData` to the first intercepted canvas 2D
  drawing call caused by a subsequent render. This does not prove that the echo
  glyph was drawn.
- `onDataToEchoGlyphSubmissionMs`: `onData` to a `fillText` call containing the
  emitted text while the parsed echo probe is present in `viewportText()`. This
  is stronger than generic canvas work but remains a diagnostic observation,
  not a physical-paint timestamp.
- `onDataToFrameCompletionMs`: `onData` through completion of all canvas calls
  in that frame. The diagnostic wraps the surface's render method to observe
  this boundary; it neither takes an extra WASM snapshot nor waits an extra frame.
- `nextAnimationFrameCallbackAt`: the harness's callback in that animation
  frame, useful for checking frame scheduling separately.
- `stalls`: timer drift, animation-frame gaps, and Chromium long tasks at or
  above 50 ms.

Canvas calls happen before browser compositing. Neither this harness nor the web
platform can honestly identify when photons changed on the physical display,
so the report deliberately says **canvas submission**, not paint latency.

`sequence` contains exact expected/emitted strings, equality, first mismatch,
and missing/unexpected suffixes. Logs are bounded to 2,000 timing samples and
500 stalls so a long manual session cannot grow without limit.

The scrolled-back case prefills 250 lines, scrolls to historical output, types
the unique marker `SCROLL_ECHO_42`, and records whether it is visible before and
after an explicit `scrollToBottom()`, plus canvas/glyph submission counts taken
before that explicit scroll. This distinguishes promptly parsed input
that remains outside the viewport from delayed parsing or canvas submission; it
does not change the surface's scroll behavior.

The lifecycle cases exercise the real `setVisible` and zero-size paths. Each
writes a unique marker while canvas work is suppressed, verifies the last
painted viewport remains stable, restores visibility or dimensions, and checks
that preserved content plus the marker appears after rendering resumes.
