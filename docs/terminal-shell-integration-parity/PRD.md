# PRD: Terminal Shell Integration & Recovery Parity with VS Code

## Problem Statement

The terminal package has a working recovery system that persists terminal state (scrollback buffer + command detection metadata) across sidecar restarts and replays it into the renderer. However, a detailed audit against VS Code's terminal recovery implementation revealed 9 gaps ranging from missing positional metadata on commands to absent capability types and incomplete OSC sequence handling.

These gaps mean:

1. **No positional metadata on commands** — Serialized commands lack `startLine`, `endLine`, `executedLine`, `promptStartLine`, `executedX`, and `startX`. Without these, the renderer cannot place gutter decorations, command navigation markers, or re-run buttons at the correct scrollback positions.

2. **Missing OSC 633;A and 633;C handling** — Prompt start and command executed sequences are not processed in the headless terminal's command detection. This means prompt start markers and executed markers are never created, which are the source of the positional metadata above.

3. **Renderer has no live command detection** — The `commands` field in the replay event is sent to the renderer and validated, but never deserialized into a live capability. The renderer xterm has no shell integration addon, no markers, and no command lifecycle events. Any future UI feature that needs to know "which command produced this output" has no data source.

4. **Incomplete `PromptInputModel` serialization** — Missing `commandStartX`, `lastUserInput`, and `ghostTextIndex` fields compared to VS Code. These are needed for accurate prompt input prediction and ghost text positioning after recovery.

5. **No OSC 633;F/G/H/I handling** — Continuation prompt start/end and right prompt start/end sequences are ignored. Multi-line command input and right-aligned prompts (common in fish, zsh with right-prompt themes) cannot be tracked.

6. **No capability types beyond command detection** — VS Code tracks 7 capability types: `CommandDetection`, `CwdDetection`, `NaiveCwdDetection`, `PartialCommandDetection`, `BufferMarkDetection`, `ShellEnvDetection`, and `PromptTypeDetection`. We only serialize command detection. This means no structured cwd change tracking, no buffer marks, no shell environment monitoring, and no prompt framework detection.

7. **No `commandStartLineContent`** — The text content of the line where a command starts is never captured from the headless terminal buffer. VS Code uses this for Windows terminal reflow handling and for providing context in command history UI.

8. **No input blocking during replay** — The renderer does not block user input, resize, or flow control ack messages during replay. VS Code sets `_inReplay = true` on both the pty host and renderer side, dropping all input/resize/signal/ack during replay to prevent corruption. While our replay is fast, this is a correctness gap.

9. **No `rawReviveBuffer` optimization** — When a terminal is serialized, replayed, and then serialized again without any user interaction, VS Code reuses the original raw buffer rather than re-serializing through the xterm serialize addon. This avoids cumulative data loss from repeated serialize/deserialize cycles on idle terminals.

10. **No OSC 7/9 cwd detection** — The standard `OSC 7` (SetCwd) and `OSC 9` (SetWindowsFriendlyCwd) sequences used by many shells for cwd reporting are not handled. Only `633;P;Cwd` is processed.

11. **No iTerm OSC 1337 handling** — iTerm's `CurrentDir` and `SetMark` sequences are ignored, reducing compatibility with iTerm-aware shell configurations.

12. **No FinalTerm OSC 133 command detection fallback** — We handle `133;A` and `133;C` for prompt state, but `133;B` (command start) and `133;D` (command finished) are not used as a command detection fallback when OSC 633 is unavailable. Shells that only emit FinalTerm sequences (like some powerlevel10k configurations) get no command detection.

## Solution

Achieve full parity with VS Code's terminal shell integration and recovery system by closing all 12 gaps. This creates a complete data foundation for terminal recovery correctness and enables rich terminal UI features.

The work spans three layers:

1. **Headless terminal (server-side)** — Evolve the existing OSC 633 handler into a full shell integration addon that tracks xterm markers, handles all OSC sequence families (633, 133, 1337, 7, 9), maintains a capability store, and produces complete serialized state including positional metadata.

2. **Data channel and persistence** — Add replay input guards, the `rawReviveBuffer` optimization, and serialize the expanded capability state alongside command detection.

3. **Renderer (client-side)** — Load a shell integration addon in the renderer xterm that deserializes commands into live markers after replay, and build basic UI for each capability type (cwd in terminal tab, buffer marks in gutter, env detection indicator, prompt type badge).

## User Stories

1. As a developer, I want recovered terminals to show command gutter decorations at the correct scrollback positions, so that I can visually distinguish command boundaries after a sidecar restart.
2. As a developer, I want to click on a command gutter marker to see the command that was run, its exit code, and its working directory, so that I can understand terminal history after recovery.
3. As a developer, I want the terminal tab or header to display the current working directory, so that I can tell which directory each terminal is in without running `pwd`.
4. As a developer, I want the cwd display to update in real-time as I `cd` between directories, so that it always reflects the current state.
5. As a developer, I want cwd detection to work with shells that emit OSC 7 (standard), OSC 9 (Windows), OSC 1337 CurrentDir (iTerm), or OSC 633;P Cwd (VS Code), so that detection works regardless of my shell configuration.
6. As a developer, I want the terminal to show buffer marks (points of interest) in the scrollback gutter when my shell emits SetMark sequences, so that I can quickly navigate to important positions.
7. As a developer, I want an indicator showing whether shell environment detection is active for a terminal, so that I know the terminal is tracking env changes.
8. As a developer, I want to see which prompt framework (powerlevel10k, oh-my-posh, starship, etc.) a terminal is using, so that I can identify terminals by their shell configuration.
9. As a developer, I want command detection to work as a fallback when my shell only emits FinalTerm (OSC 133) sequences instead of VS Code (OSC 633) sequences, so that basic command tracking works with any shell integration.
10. As a developer, I want multi-line commands (with continuation prompts) to be tracked as a single command, so that command boundaries are correct for complex shell inputs.
11. As a developer, I want right-aligned prompt content to be tracked separately from the main prompt, so that prompt parsing is not confused by right-prompt themes.
12. As a developer, I want each serialized command to include the line where the prompt started, where the command started, where execution began, and where output ended, so that the renderer can place decorations precisely.
13. As a developer, I want the `commandStartLineContent` to be captured for each command, so that the command start line can be displayed in history UI and used for Windows reflow handling.
14. As a developer, I want the renderer to block all input and resize events during terminal replay, so that user keystrokes or window resizing cannot corrupt the replayed terminal state.
15. As a developer, I want the renderer to resume accepting input immediately after replay completes, so that there is no perceptible delay after recovery.
16. As a developer, I want idle terminals (never interacted with after recovery) to be re-serialized efficiently by reusing the original buffer, so that repeated sidecar restarts do not degrade scrollback through cumulative serialize/deserialize loss.
17. As a developer, I want terminals that I have interacted with after recovery to be serialized fresh (not from the stale buffer), so that my new input is captured correctly.
18. As a developer, I want the prompt input model to include ghost text positioning after recovery, so that inline suggestions resume correctly.
19. As a developer, I want the prompt input model to include the command start column and last user input after recovery, so that prompt editing state is fully restored.
20. As a developer, I want command detection state to survive the full roundtrip: live tracking in headless terminal, serialization to disk, replay over data channel, deserialization into renderer xterm markers, so that no command metadata is lost during recovery.
21. As a developer, I want commands detected via nonce-verified OSC 633;E to be marked as trusted after recovery, so that re-run and command history features can distinguish verified from unverified command lines.
22. As a developer, I want the renderer to fire `onCommandStarted` and `onCommandFinished` events after deserializing recovered commands, so that decoration addons and UI consumers can react to restored command state.
23. As a developer, I want the capability store to be serializable alongside command detection in the replay event, so that all capability state survives recovery.
24. As a developer, I want the cwd display to restore correctly after recovery using the persisted cwd detection state, so that the tab shows the right directory immediately after replay.
25. As a developer, I want buffer marks to restore correctly after recovery, so that gutter indicators appear at the right positions in the replayed scrollback.

## 'Polishing' Requirements

1. Verify that command gutter decorations align perfectly with the actual command output boundaries in scrollback — check with multi-line commands, empty commands, and commands with very long output.
2. Ensure the cwd display in the terminal tab truncates gracefully for long paths — show the last 2-3 path segments with an ellipsis for deeply nested directories.
3. Verify that the prompt type badge does not cause layout shifts in the terminal header — use a fixed-width container.
4. Test that the env detection indicator is subtle in normal operation (small icon/dot) and does not distract from terminal content.
5. Ensure that the replay input guard does not cause a visible "frozen input" moment — replay should complete fast enough that the guard is imperceptible. If replay takes longer than 200ms, show a brief "Restoring..." overlay.
6. Verify that the `rawReviveBuffer` optimization does not cause stale state — confirm that any user interaction (keystroke, resize, title change) invalidates the raw buffer.
7. Test that FinalTerm fallback command detection produces reasonable results with powerlevel10k's instant prompt feature, which emits OSC 133 sequences before the shell integration script runs.
8. Verify that all four capability UI elements (cwd, marks, env indicator, prompt type) respect the terminal's current color theme and do not introduce visual inconsistencies.
9. Ensure that the shell integration addon in the headless terminal does not generate device query responses (DA1/DSR) — only the renderer xterm should respond to queries.
10. Test that rapid command execution (e.g., running a loop that outputs hundreds of commands per second) does not cause memory pressure in the capability store — verify commands are bounded or trimmed.

## Implementation Decisions

### Module 1: Shell Integration Addon (Headless)

Evolve the existing `headless-terminal.ts` OSC handling into a full shell integration addon. This is the natural location since it already has a headless xterm instance per terminal with `@xterm/addon-serialize` loaded.

Changes:
- Register xterm markers via `terminal.registerMarker()` when processing OSC sequences that define positional boundaries (633;A for prompt start, 633;B for command start, 633;C for command executed, 633;D for command end)
- Track marker line numbers in the `InFlightCommand` structure so they can be serialized into `startLine`, `promptStartLine`, `endLine`, `executedLine`
- Track cursor X positions for `startX` and `executedX` by reading `terminal.buffer.active.cursorX` at the appropriate OSC events
- Capture `commandStartLineContent` by reading the terminal buffer line content at command start
- Add OSC 633;A handler: record prompt start marker, transition prompt state
- Add OSC 633;C handler: record executed marker and `executedX`, transition prompt state to running
- Add OSC 633;F/G handlers: track continuation prompt boundaries (set/clear a "in continuation" flag on the current command)
- Add OSC 633;H/I handlers: track right prompt boundaries (record right prompt markers)
- Complete `PromptInputModel` with `commandStartX` (cursor X at 633;B), `lastUserInput` (last input string before 633;C), and `ghostTextIndex` (from prompt input model tracking)
- Add OSC 133;B handler: FinalTerm command start fallback — if no OSC 633 command detection is active, create a command start marker
- Add OSC 133;D handler: FinalTerm command finished fallback — if no OSC 633 command detection is active, finalize the current command with exit code
- Add OSC 7 handler: parse `file://` URI for cwd, feed into cwd detection capability
- Add OSC 9 handler: parse Windows-friendly cwd format, feed into cwd detection capability
- Add OSC 1337 handler: `CurrentDir` feeds cwd detection, `SetMark` feeds buffer mark detection
- The addon interface remains the same: `getCommandDetectionState(terminalId)` returns the full serialized state. A new `getCapabilityState(terminalId)` method returns the full capability store.

### Module 2: Capability Store

A new module in the terminal package that provides a typed capability store, mirroring VS Code's `TerminalCapabilityStore`.

Capabilities tracked:
- **CwdDetection** — Maintains a list of cwd change events `{ cwd: string, line: number | undefined }`. Fed by OSC 633;P Cwd, OSC 7, OSC 9, and OSC 1337 CurrentDir. Exposes the current cwd and an event history.
- **BufferMarkDetection** — Maintains a list of buffer marks `{ line: number, id?: string, hidden?: boolean }`. Fed by OSC 633 SetMark and OSC 633;P Task.
- **ShellEnvDetection** — Maintains the latest shell environment as a `Map<string, string>` with a trust flag. Fed by OSC 633 EnvJson and EnvSingle* sequences. Nonce verification determines trust.
- **PromptTypeDetection** — Stores the detected prompt type string (e.g., "p10k", "posh-git", "starship"). Fed by OSC 633;P PromptType.

The capability store is serializable. The serialized form extends the replay event to include capability state alongside command detection. The store is per-terminal and maintained in the headless terminal manager.

### Module 3: Replay Input Guard

Modifications to both the data channel (server-side) and the renderer (client-side) to block input during replay.

Server-side: The data channel already buffers live output during replay. Add a flag that also causes incoming renderer messages (input keystrokes, resize requests, flow control acks) to be dropped during the replay window — from `encodeReplay()` send through `encodeReplayComplete()` send.

Client-side: The renderer's message port hook tracks `replayStatus`. When `replayStatus === 'replaying'`, the `send()` function should no-op (drop user input). The terminal pane should not forward resize events during replay. After `replayComplete`, input resumes immediately.

### Module 4: Shell Integration Addon (Renderer)

A new module in the web app that provides a shell integration addon for the renderer's xterm instance. This addon:

- Is loaded into the renderer xterm alongside the existing addons (fit, WebGL, etc.)
- Receives the `ISerializedCommandDetectionCapability` after replay completes
- Deserializes commands by registering xterm markers at the serialized line positions (using `xterm.registerMarker(line - (buffer.baseY + buffer.cursorY))`)
- Fires `onCommandStarted` and `onCommandFinished` events that UI consumers (decoration addon, command history panel) can subscribe to
- Continues to process live OSC 633/133 sequences for commands that arrive after recovery, so command detection remains live
- Restores capability state (cwd, buffer marks, etc.) from the serialized capability store

The partial/in-flight command (identified by `endLine === undefined`) is deserialized into the "current command" state rather than the finished commands list, and fires `onCommandStarted`.

### Module 5: rawReviveBuffer Optimization

Modification to the persistence layer to track interaction state per terminal:

- **None** — Terminal has never been interacted with (freshly spawned or just recovered)
- **ReplayOnly** — Terminal has been replayed to a renderer but user never typed or resized
- **Session** — User has directly interacted (input, resize, title change)

When serializing a terminal in `None` or `ReplayOnly` state, the persistence layer stores the raw replay buffer as-is rather than re-serializing through the xterm serialize addon. When user interaction occurs, the raw buffer reference is freed and subsequent serializations use the live xterm state.

The headless terminal manager should expose a `freeRawReviveBuffer(terminalId)` method. The terminal manager calls this on any user interaction event: input write, explicit resize from the renderer, or title change.

### Module 6: Terminal UI Enhancements

Modifications to the web app's terminal components:

- **Cwd in terminal tab** — The terminal tab/header component reads the current cwd from the capability store (via the shell integration addon or a dedicated atom). Displays the last 2-3 path segments. Updates reactively on cwd change events.
- **Buffer mark gutter indicators** — A decoration addon attached to the renderer xterm that renders mark indicators in the scrollback gutter at the line positions from the buffer mark capability. Uses xterm's decoration API.
- **Prompt type badge** — A small badge or label in the terminal header showing the detected prompt framework name. Only visible when prompt type detection is active.
- **Env detection indicator** — A small icon/dot in the terminal header indicating that shell environment detection is active for this terminal. Does not show env var contents, just the detection status.

### OSC Sequence Handling Matrix

| Sequence | Current | After | Module |
|----------|---------|-------|--------|
| 633;A (PromptStart) | Not handled for command detection | Creates prompt start marker | 1 |
| 633;B (CommandStart) | Creates InFlightCommand | Also creates command start marker, records startX, commandStartLineContent | 1 |
| 633;C (CommandExecuted) | Not handled | Creates executed marker, records executedX | 1 |
| 633;D (CommandFinished) | Pushes completed command | Also records endLine from end marker | 1 |
| 633;E (CommandLine) | Sets command text + trust | No change needed | — |
| 633;F (ContinuationStart) | Not handled | Tracks continuation state | 1 |
| 633;G (ContinuationEnd) | Not handled | Clears continuation state | 1 |
| 633;H (RightPromptStart) | Not handled | Tracks right prompt marker | 1 |
| 633;I (RightPromptEnd) | Not handled | Clears right prompt state | 1 |
| 633;P Cwd | Updates commandState.cwd | Also feeds CwdDetection capability | 1, 2 |
| 633;P ContinuationPrompt | Updates prompt model | No change needed | — |
| 633;P HasRichCommandDetection | Sets boolean | No change needed | — |
| 633;P IsWindows | Sets boolean | No change needed | — |
| 633;P Prompt | Extracts terminator | No change needed | — |
| 633;P PromptType | Not handled | Feeds PromptTypeDetection capability | 1, 2 |
| 633;P Task | Not handled | Feeds BufferMarkDetection capability | 1, 2 |
| 633 SetMark | Not handled | Feeds BufferMarkDetection capability | 1, 2 |
| 633 EnvJson | Not handled | Feeds ShellEnvDetection capability (nonce-verified) | 1, 2 |
| 633 EnvSingle* | Not handled | Feeds ShellEnvDetection capability (nonce-verified) | 1, 2 |
| 133;A (PromptStart) | Emits prompt idle state | No change needed | — |
| 133;B (CommandStart) | Not handled | FinalTerm fallback: creates command start if no 633 detection | 1 |
| 133;C (CommandExecuted) | Emits prompt running state | No change needed | — |
| 133;D (CommandFinished) | Not handled | FinalTerm fallback: finalizes command if no 633 detection | 1 |
| 7 (SetCwd) | Not handled | Parses file:// URI, feeds CwdDetection | 1, 2 |
| 9 (SetWindowsFriendlyCwd) | Not handled | Parses Windows path, feeds CwdDetection | 1, 2 |
| 1337 CurrentDir | Not handled | Feeds CwdDetection capability | 1, 2 |
| 1337 SetMark | Not handled | Feeds BufferMarkDetection capability | 1, 2 |

### Serialization Changes

The `SerializedReplayEvent` type expands to include a `capabilities` field:

```
SerializedReplayEvent {
  events: SerializedReplayFrame[]
  commands?: SerializedCommandDetectionCapability
  capabilities?: SerializedCapabilityStore    // NEW
}
```

The `SerializedCapabilityStore` includes:

```
SerializedCapabilityStore {
  cwdDetection?: { cwd: string; history: { cwd: string; line?: number }[] }
  bufferMarks?: { line: number; id?: string; hidden?: boolean }[]
  shellEnvDetection?: { env: Record<string, string>; isTrusted: boolean }
  promptType?: string
}
```

The `SerializedPromptInputModel` expands to match VS Code:

```
SerializedPromptInputModel {
  value: string
  cursorIndex: number
  ghostTextIndex: number             // NEW — -1 if no ghost text
  commandStartX: number              // NEW
  lastPromptLine?: string
  continuationPrompt?: string
  lastUserInput: string              // NEW
}
```

The serialized state version should be bumped from 2 to 3 to reflect the expanded schema.

## Testing Decisions

### What makes a good test

Tests should verify behavior through public boundaries — given specific OSC input sequences written to the headless terminal, assert the serialized output state. Tests should not depend on internal data structures or implementation details of the OSC parser. The existing test files (`headless-terminal.test.ts`, `terminal-session-persistence.test.ts`, `terminal-data-channel.test.ts`, `terminal-manager.test.ts`) provide prior art for this pattern.

### Modules to test

**Module 1 (Shell Integration Addon — Headless):**
- Given OSC 633;A + 633;B + 633;C + 633;D sequences, assert that `getCommandDetectionState()` returns commands with correct `startLine`, `promptStartLine`, `executedLine`, `endLine`, `executedX`, `startX`
- Given OSC 633;B, assert `commandStartLineContent` is captured from the buffer
- Given OSC 633;F + 633;G sequences around multi-line input, assert the continuation flag is tracked
- Given OSC 633;H + 633;I sequences, assert right prompt markers are tracked
- Given OSC 133;B + 133;D sequences (without any 633), assert FinalTerm fallback command detection works
- Given OSC 7 with a `file://` URI, assert cwd is detected
- Given OSC 9 with a Windows path, assert cwd is detected
- Given OSC 1337 CurrentDir, assert cwd is detected
- Given OSC 1337 SetMark, assert buffer mark is tracked
- Given OSC 633;P PromptType, assert prompt type is detected
- Given OSC 633 EnvJson with valid nonce, assert env is tracked and trusted
- Given OSC 633 EnvJson with invalid nonce, assert env is tracked but untrusted

**Module 2 (Capability Store):**
- Serialization roundtrip: serialize capability store, restore from serialized, assert state matches
- CwdDetection: multiple cwd changes produce correct history
- BufferMarkDetection: marks with and without IDs are tracked correctly
- ShellEnvDetection: trust flag propagates correctly across batched updates
- PromptTypeDetection: stores and serializes prompt type string

**Module 3 (Replay Input Guard):**
- During replay, input messages from the renderer are dropped (not forwarded to pty)
- During replay, resize messages from the renderer are dropped
- After replayComplete, input and resize resume
- Existing data channel tests provide prior art

**Module 4 (Shell Integration Addon — Renderer):**
- Given a serialized command detection state, assert that deserialization registers correct xterm markers
- Given a partial command (endLine undefined), assert it is deserialized as current command and fires onCommandStarted
- Given full commands, assert onCommandFinished fires for each
- Assert that live OSC sequences after deserialization continue to work

**Module 5 (rawReviveBuffer Optimization):**
- Terminal in None state: serialization returns raw buffer
- Terminal in ReplayOnly state: serialization returns raw buffer
- Terminal in Session state (after user input): serialization uses live xterm serialize
- User interaction transitions state from ReplayOnly to Session and frees raw buffer

**Module 6 (Terminal UI Enhancements):**
- Cwd display component renders last path segments correctly
- Cwd display updates reactively on cwd change
- Buffer mark decoration addon renders indicators at correct line positions
- Prompt type badge renders when prompt type is detected and hides when not
- Env detection indicator renders when env detection is active

## Out of Scope

- **Full VS Code command navigation** — VS Code has Ctrl+Up/Down to jump between commands in scrollback. While the data foundation for this is being built, the keyboard navigation feature itself is out of scope.
- **Command re-run UI** — Re-run buttons or context menus on command gutters require additional UI design work and are out of scope. The data (trusted command lines, exit codes) will be available.
- **NaiveCwdDetection** — VS Code's fallback cwd detection that queries the process tree. This is a separate concern from shell integration and is out of scope.
- **PartialCommandDetection capability** — VS Code creates this immediately on addon activation as a minimal fallback. Our prompt state tracking already covers this use case and a separate capability type adds no value.
- **Command history panel** — A dedicated panel showing command history with search/filter. The data will be available but the UI panel is a separate feature.
- **Terminal decorations for exit codes** — Colored gutter indicators (green/red) based on command exit codes. This is a natural follow-on but requires design decisions about visual treatment.
- **Shell integration script injection** — VS Code injects shell integration scripts into bash/zsh/fish/pwsh. Our terminals already receive these sequences from the shell (presumably via the user's shell configuration or VS Code's scripts). Script injection is out of scope.
- **Unicode version tracking** — VS Code tracks and serializes the xterm unicode version (6 or 11). This is orthogonal to shell integration and not part of this PRD.

## Further Notes

- The OSC 633;F/G (continuation) and 633;H/I (right prompt) sequences are marked "UNFINALIZED" in VS Code's source. Our implementation should handle them but should be prepared for potential changes to the protocol.
- The EnvJson and EnvSingle* sequences for shell environment detection are also "UNFINALIZED" in VS Code. The nonce verification for these sequences is mandatory (not optional like for 633;E).
- VS Code prioritizes OSC 633 over OSC 133 — once any 633 sequence is seen, the shell integration status permanently becomes "VSCode". FinalTerm sequences continue to be processed for prompt state but command detection falls back to 633. Our implementation should follow this same priority scheme.
- The `rawReviveBuffer` optimization specifically addresses a data fidelity concern: the xterm serialize addon is lossy (it captures visible buffer state but may not perfectly reproduce the original VT escape sequence stream). Repeatedly serializing and deserializing degrades quality over time. By reusing the raw buffer for idle terminals, this degradation is bounded to one serialize/deserialize cycle per user interaction epoch.
- The renderer-side shell integration addon should set `wasReplayed: true` on deserialized commands. This flag can be used by future decoration code to style replayed commands differently from live ones (e.g., slightly dimmed gutter markers).
