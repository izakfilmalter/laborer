# Ghostty Integration — Unsupported Actions at Launch

This document enumerates the Ghostty runtime actions that Laborer intentionally does not support in the first production version. These are tracked as a backlog with real usage observability, not undocumented omissions.

## Supported Actions (7)

These actions are fully handled by the Laborer integration (Issue 7):

| Action | Description |
|--------|-------------|
| `set_title` | Terminal title changes reflected in Laborer UI |
| `pwd` | Working directory updates surfaced to metadata model |
| `ring_bell` | Bell notifications shown as visual flash |
| `child_exited` | Child process exit updates pane state |
| `close_window` | Window close request updates pane state |
| `cell_size` | Cell dimension changes received (no-op — renderer controls sizing) |
| `renderer_health` | Renderer health changes logged for monitoring |

## Handled Internally (1)

| Action | Description |
|--------|-------------|
| `render` | Render requests handled by the Metal layer automatically — never forwarded to JS |

## Unsupported Actions by Category

### Split Management

Laborer owns its own pane model. Ghostty split actions are not applicable.

| Action | Description |
|--------|-------------|
| `new_split` | Split creation handled by Laborer pane model, not Ghostty |
| `goto_split` | Split navigation handled by Laborer pane model |
| `resize_split` | Split resizing handled by Laborer pane model |
| `equalize_splits` | Split equalization handled by Laborer pane model |
| `toggle_split_zoom` | Split zoom handled by Laborer pane model |

### Tab Management

Laborer owns its own workspace/tab model.

| Action | Description |
|--------|-------------|
| `new_tab` | Tab creation handled by Laborer workspace model |
| `close_tab` | Tab closing handled by Laborer workspace model |
| `move_tab` | Tab reordering handled by Laborer workspace model |
| `goto_tab` | Tab navigation handled by Laborer workspace model |
| `toggle_tab_overview` | Tab overview UI not applicable in Laborer |

### Window Management

Laborer uses Electron for window management.

| Action | Description |
|--------|-------------|
| `quit` | App quit handled by Electron, not Ghostty |
| `new_window` | Window creation handled by Electron |
| `close_all_windows` | Window management handled by Electron |
| `toggle_maximize` | Window maximize handled by Electron |
| `toggle_fullscreen` | Fullscreen handled by Electron |
| `toggle_window_decorations` | Window decorations handled by Electron |
| `toggle_quick_terminal` | Quick terminal UI not applicable in Laborer |
| `toggle_visibility` | App visibility handled by Electron |
| `toggle_background_opacity` | Background opacity not applicable in embedded terminal |
| `goto_window` | Window navigation handled by Electron |
| `present_terminal` | Terminal presentation handled by Laborer pane model |
| `size_limit` | Size limits handled by Laborer layout system |
| `reset_window_size` | Window sizing handled by Electron |
| `initial_size` | Initial size handled by Laborer layout system |
| `float_window` | Window floating handled by Electron |
| `quit_timer` | Quit timer handled by Electron |
| `check_for_updates` | Update checking handled by Laborer, not Ghostty |

### Search UI

Ghostty's search UI is not used in Laborer. Laborer may implement its own terminal search in the future.

| Action | Description |
|--------|-------------|
| `start_search` | Search UI deferred — Laborer may implement its own |
| `end_search` | Search UI deferred |
| `search_total` | Search result counts deferred |
| `search_selected` | Search selection deferred |

### Key Overlays

Advanced key sequence and key table overlay UIs.

| Action | Description |
|--------|-------------|
| `key_sequence` | Key sequence overlay UI deferred |
| `key_table` | Key table overlay UI deferred |
| `toggle_command_palette` | Command palette deferred — Laborer has its own |

### URL Handling

Beyond Laborer's existing link behavior.

| Action | Description |
|--------|-------------|
| `open_url` | URL opening deferred — may use Electron shell.openExternal |
| `mouse_over_link` | Link hover detection deferred |

### Notifications

Beyond core bell handling.

| Action | Description |
|--------|-------------|
| `desktop_notification` | Desktop notifications deferred — may use Electron Notification API |

### Progress and Command Tracking

| Action | Description |
|--------|-------------|
| `progress_report` | Progress reporting deferred |
| `command_finished` | Command finished integration deferred |

### Scrollbar UI

Native Ghostty UI affordance that does not map directly into Laborer's design.

| Action | Description |
|--------|-------------|
| `scrollbar` | Scrollbar UI does not map to Laborer design |

### Inspector / Debug Tools

| Action | Description |
|--------|-------------|
| `inspector` | Ghostty inspector not applicable in embedded context |
| `render_inspector` | Render inspector not applicable in embedded context |

### Config UI

| Action | Description |
|--------|-------------|
| `open_config` | Config file opening deferred — Laborer may provide its own |
| `reload_config` | Config reload deferred |
| `config_change` | Config change notification deferred |

### Clipboard UI

| Action | Description |
|--------|-------------|
| `prompt_title` | Title prompt UI deferred |
| `copy_title_to_clipboard` | Copy title to clipboard deferred |

### Deferred (needs future work)

| Action | Description |
|--------|-------------|
| `mouse_shape` | Mouse cursor shape changes — needs renderer integration |
| `mouse_visibility` | Mouse cursor visibility changes |
| `color_change` | Terminal color scheme changes |
| `secure_input` | Secure input mode |
| `undo` | Not applicable in terminal context |
| `redo` | Not applicable in terminal context |
| `readonly` | Read-only mode |

### Platform Irrelevant

| Action | Description |
|--------|-------------|
| `show_gtk_inspector` | GTK inspector not applicable on macOS |
| `show_on_screen_keyboard` | On-screen keyboard not applicable on macOS desktop |

## Observability

Unsupported actions are:
- Queued in the native addon with an `unsupported:<name>` prefix
- Forwarded through the host process as `unsupported_action` push events
- Logged with rate limiting (first 3 occurrences per action name, then counted silently)
- Counted in-memory for diagnostics via `getUnsupportedActionCounts()`
- Forwarded to the renderer via the existing action event pipeline

This means unsupported actions:
1. Never crash the helper process or blank the terminal
2. Are visible in host process logs for debugging
3. Can be queried programmatically for telemetry/prioritization
4. Flow through the full event pipeline safely
