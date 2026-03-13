/**
 * Ghostty Unsupported Actions Registry
 *
 * Enumerates all Ghostty actions and classifies them as supported,
 * handled-internally, or unsupported. Unsupported actions are further
 * categorized by reason so the team can prioritize future work from
 * real usage data rather than guesswork.
 *
 * This module fulfills the PRD requirement that unsupported actions
 * are part of the product contract, not an undocumented omission.
 */

// ---------------------------------------------------------------------------
// Action support status
// ---------------------------------------------------------------------------

/**
 * Why an action is unsupported in the current Laborer integration.
 */
type UnsupportedReason =
  | 'split_management'
  | 'tab_management'
  | 'window_management'
  | 'search_ui'
  | 'key_overlay'
  | 'url_handling'
  | 'notification'
  | 'progress_reporting'
  | 'scrollbar_ui'
  | 'inspector'
  | 'config_ui'
  | 'clipboard_ui'
  | 'input_ui'
  | 'platform_irrelevant'
  | 'deferred'

/**
 * Classification of a Ghostty action in the Laborer integration.
 */
type ActionStatus =
  | { readonly status: 'supported'; readonly description: string }
  | { readonly status: 'handled_internally'; readonly description: string }
  | {
      readonly status: 'unsupported'
      readonly reason: UnsupportedReason
      readonly description: string
    }

/**
 * Complete registry of all Ghostty actions with their support status.
 *
 * Action names match the strings used by the native addon when queuing
 * actions (e.g., "set_title" for GHOSTTY_ACTION_SET_TITLE). Unsupported
 * actions use the "unsupported:<name>" format from the native addon.
 */
const GHOSTTY_ACTION_REGISTRY: Record<string, ActionStatus> = {
  // -----------------------------------------------------------------------
  // Supported actions — handled by the Laborer integration (Issue 7)
  // -----------------------------------------------------------------------
  set_title: {
    status: 'supported',
    description: 'Terminal title changes reflected in Laborer UI',
  },
  pwd: {
    status: 'supported',
    description: 'Working directory updates surfaced to metadata model',
  },
  ring_bell: {
    status: 'supported',
    description: 'Bell notifications shown as visual flash',
  },
  child_exited: {
    status: 'supported',
    description: 'Child process exit updates pane state',
  },
  close_window: {
    status: 'supported',
    description: 'Window close request updates pane state',
  },
  cell_size: {
    status: 'supported',
    description:
      'Cell dimension changes received (no-op — renderer controls sizing)',
  },
  renderer_health: {
    status: 'supported',
    description: 'Renderer health changes logged for monitoring',
  },

  // -----------------------------------------------------------------------
  // Handled internally — processed by the native addon, not forwarded to JS
  // -----------------------------------------------------------------------
  render: {
    status: 'handled_internally',
    description: 'Render requests handled by the Metal layer automatically',
  },

  // -----------------------------------------------------------------------
  // Unsupported actions — classified by category
  // -----------------------------------------------------------------------

  // Split management — Laborer owns its own pane model
  new_split: {
    status: 'unsupported',
    reason: 'split_management',
    description: 'Split creation handled by Laborer pane model, not Ghostty',
  },
  goto_split: {
    status: 'unsupported',
    reason: 'split_management',
    description: 'Split navigation handled by Laborer pane model',
  },
  resize_split: {
    status: 'unsupported',
    reason: 'split_management',
    description: 'Split resizing handled by Laborer pane model',
  },
  equalize_splits: {
    status: 'unsupported',
    reason: 'split_management',
    description: 'Split equalization handled by Laborer pane model',
  },
  toggle_split_zoom: {
    status: 'unsupported',
    reason: 'split_management',
    description: 'Split zoom handled by Laborer pane model',
  },

  // Tab management — Laborer owns its own tab/pane model
  new_tab: {
    status: 'unsupported',
    reason: 'tab_management',
    description: 'Tab creation handled by Laborer workspace model',
  },
  close_tab: {
    status: 'unsupported',
    reason: 'tab_management',
    description: 'Tab closing handled by Laborer workspace model',
  },
  move_tab: {
    status: 'unsupported',
    reason: 'tab_management',
    description: 'Tab reordering handled by Laborer workspace model',
  },
  goto_tab: {
    status: 'unsupported',
    reason: 'tab_management',
    description: 'Tab navigation handled by Laborer workspace model',
  },
  toggle_tab_overview: {
    status: 'unsupported',
    reason: 'tab_management',
    description: 'Tab overview UI not applicable in Laborer',
  },

  // Window management — Laborer owns its Electron window model
  quit: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'App quit handled by Electron, not Ghostty',
  },
  new_window: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Window creation handled by Electron',
  },
  close_all_windows: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Window management handled by Electron',
  },
  toggle_maximize: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Window maximize handled by Electron',
  },
  toggle_fullscreen: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Fullscreen handled by Electron',
  },
  toggle_window_decorations: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Window decorations handled by Electron',
  },
  toggle_quick_terminal: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Quick terminal UI not applicable in Laborer',
  },
  toggle_visibility: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'App visibility handled by Electron',
  },
  toggle_background_opacity: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Background opacity not applicable in embedded terminal',
  },
  goto_window: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Window navigation handled by Electron',
  },
  present_terminal: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Terminal presentation handled by Laborer pane model',
  },
  size_limit: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Size limits handled by Laborer layout system',
  },
  reset_window_size: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Window sizing handled by Electron',
  },
  initial_size: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Initial size handled by Laborer layout system',
  },
  float_window: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Window floating handled by Electron',
  },

  // Search UI — Ghostty search not used in Laborer
  start_search: {
    status: 'unsupported',
    reason: 'search_ui',
    description: 'Search UI deferred — Laborer may implement its own',
  },
  end_search: {
    status: 'unsupported',
    reason: 'search_ui',
    description: 'Search UI deferred',
  },
  search_total: {
    status: 'unsupported',
    reason: 'search_ui',
    description: 'Search result counts deferred',
  },
  search_selected: {
    status: 'unsupported',
    reason: 'search_ui',
    description: 'Search selection deferred',
  },

  // Key overlays — advanced key sequence/table UI
  key_sequence: {
    status: 'unsupported',
    reason: 'key_overlay',
    description: 'Key sequence overlay UI deferred',
  },
  key_table: {
    status: 'unsupported',
    reason: 'key_overlay',
    description: 'Key table overlay UI deferred',
  },
  toggle_command_palette: {
    status: 'unsupported',
    reason: 'key_overlay',
    description: 'Command palette deferred — Laborer has its own',
  },

  // URL handling — beyond Laborer's existing link behavior
  open_url: {
    status: 'unsupported',
    reason: 'url_handling',
    description: 'URL opening deferred — may use Electron shell.openExternal',
  },
  mouse_over_link: {
    status: 'unsupported',
    reason: 'url_handling',
    description: 'Link hover detection deferred',
  },

  // Notifications — beyond core bell handling
  desktop_notification: {
    status: 'unsupported',
    reason: 'notification',
    description:
      'Desktop notifications deferred — may use Electron Notification API',
  },

  // Progress and command tracking
  progress_report: {
    status: 'unsupported',
    reason: 'progress_reporting',
    description: 'Progress reporting deferred',
  },
  command_finished: {
    status: 'unsupported',
    reason: 'progress_reporting',
    description: 'Command finished integration deferred',
  },

  // Scrollbar — native Ghostty UI affordance
  scrollbar: {
    status: 'unsupported',
    reason: 'scrollbar_ui',
    description: 'Scrollbar UI does not map to Laborer design',
  },

  // Inspector — developer/debug tools
  inspector: {
    status: 'unsupported',
    reason: 'inspector',
    description: 'Ghostty inspector not applicable in embedded context',
  },
  show_gtk_inspector: {
    status: 'unsupported',
    reason: 'platform_irrelevant',
    description: 'GTK inspector not applicable on macOS',
  },
  render_inspector: {
    status: 'unsupported',
    reason: 'inspector',
    description: 'Render inspector not applicable in embedded context',
  },

  // Config UI
  open_config: {
    status: 'unsupported',
    reason: 'config_ui',
    description: 'Config file opening deferred — Laborer may provide its own',
  },
  reload_config: {
    status: 'unsupported',
    reason: 'config_ui',
    description: 'Config reload deferred',
  },
  config_change: {
    status: 'unsupported',
    reason: 'config_ui',
    description: 'Config change notification deferred',
  },

  // Clipboard UI
  prompt_title: {
    status: 'unsupported',
    reason: 'clipboard_ui',
    description: 'Title prompt UI deferred',
  },
  copy_title_to_clipboard: {
    status: 'unsupported',
    reason: 'clipboard_ui',
    description: 'Copy title to clipboard deferred',
  },

  // Mouse cursor — needs renderer-side cursor changes
  mouse_shape: {
    status: 'unsupported',
    reason: 'deferred',
    description:
      'Mouse cursor shape changes deferred — needs renderer integration',
  },
  mouse_visibility: {
    status: 'unsupported',
    reason: 'deferred',
    description: 'Mouse cursor visibility changes deferred',
  },

  // Color changes
  color_change: {
    status: 'unsupported',
    reason: 'deferred',
    description: 'Terminal color scheme changes deferred',
  },

  // Miscellaneous deferred
  quit_timer: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Quit timer handled by Electron',
  },
  secure_input: {
    status: 'unsupported',
    reason: 'deferred',
    description: 'Secure input mode deferred',
  },
  undo: {
    status: 'unsupported',
    reason: 'deferred',
    description: 'Undo not applicable in terminal context',
  },
  redo: {
    status: 'unsupported',
    reason: 'deferred',
    description: 'Redo not applicable in terminal context',
  },
  check_for_updates: {
    status: 'unsupported',
    reason: 'window_management',
    description: 'Update checking handled by Laborer, not Ghostty',
  },
  show_on_screen_keyboard: {
    status: 'unsupported',
    reason: 'platform_irrelevant',
    description: 'On-screen keyboard not applicable on macOS desktop',
  },
  readonly: {
    status: 'unsupported',
    reason: 'deferred',
    description: 'Read-only mode deferred',
  },
}

// ---------------------------------------------------------------------------
// Unsupported action tracking (rate-limited logging)
// ---------------------------------------------------------------------------

/** Count of each unsupported action seen since process start. */
const unsupportedActionCounts = new Map<string, number>()

/**
 * Maximum number of log lines per unsupported action name.
 * After this threshold, the action is counted silently.
 * This prevents log spam from high-frequency actions like mouse_shape.
 */
const LOG_THRESHOLD = 3

/**
 * Record an unsupported action occurrence.
 * Logs the first few occurrences with context, then counts silently.
 *
 * @param actionName - The unsupported action name (without "unsupported:" prefix)
 * @param surfaceId - The surface ID the action targeted (0 for app-level)
 * @returns The current count of this action
 */
const recordUnsupportedAction = (
  actionName: string,
  surfaceId: number
): number => {
  const count = (unsupportedActionCounts.get(actionName) ?? 0) + 1
  unsupportedActionCounts.set(actionName, count)

  if (count <= LOG_THRESHOLD) {
    const entry = GHOSTTY_ACTION_REGISTRY[actionName]
    const reason =
      entry !== undefined && entry.status === 'unsupported'
        ? entry.reason
        : 'unknown'
    const description =
      entry !== undefined ? entry.description : 'Unknown Ghostty action'
    console.error(
      `[ghostty] Unsupported action: ${actionName} (reason=${reason}, surfaceId=${surfaceId}) — ${description}`
    )
    if (count === LOG_THRESHOLD) {
      console.error(
        `[ghostty] Suppressing further logs for "${actionName}" (will count silently)`
      )
    }
  }

  return count
}

/**
 * Get a snapshot of all unsupported action counts since process start.
 * Useful for diagnostics, telemetry, or tests.
 */
const getUnsupportedActionCounts = (): ReadonlyMap<string, number> => {
  return new Map(unsupportedActionCounts)
}

/**
 * Reset all unsupported action counts. Primarily for testing.
 */
const resetUnsupportedActionCounts = (): void => {
  unsupportedActionCounts.clear()
}

/**
 * Get all unsupported action names from the registry.
 */
const getUnsupportedActions = (): readonly string[] => {
  return Object.entries(GHOSTTY_ACTION_REGISTRY)
    .filter(([, entry]) => entry.status === 'unsupported')
    .map(([name]) => name)
}

/**
 * Get all supported action names from the registry.
 */
const getSupportedActions = (): readonly string[] => {
  return Object.entries(GHOSTTY_ACTION_REGISTRY)
    .filter(([, entry]) => entry.status === 'supported')
    .map(([name]) => name)
}

/**
 * Get unsupported actions grouped by reason.
 */
const getUnsupportedActionsByReason = (): ReadonlyMap<
  UnsupportedReason,
  readonly string[]
> => {
  const grouped = new Map<UnsupportedReason, string[]>()
  for (const [name, entry] of Object.entries(GHOSTTY_ACTION_REGISTRY)) {
    if (entry.status === 'unsupported') {
      const existing = grouped.get(entry.reason)
      if (existing !== undefined) {
        existing.push(name)
      } else {
        grouped.set(entry.reason, [name])
      }
    }
  }
  return grouped
}

/**
 * Check if an action name is in the unsupported registry.
 * Accepts both raw names ("mouse_shape") and prefixed names ("unsupported:mouse_shape").
 */
const isUnsupportedAction = (actionName: string): boolean => {
  const name = actionName.startsWith('unsupported:')
    ? actionName.slice('unsupported:'.length)
    : actionName
  const entry = GHOSTTY_ACTION_REGISTRY[name]
  return entry !== undefined && entry.status === 'unsupported'
}

export {
  getUnsupportedActionCounts,
  getUnsupportedActions,
  getUnsupportedActionsByReason,
  getSupportedActions,
  isUnsupportedAction,
  recordUnsupportedAction,
  resetUnsupportedActionCounts,
  GHOSTTY_ACTION_REGISTRY,
}
export type { ActionStatus, UnsupportedReason }
