/**
 * Centralized polling intervals and timing constants.
 *
 * All clock-driven behavior in the server's service layer is defined
 * here so intervals can be tuned in a single place. Constants are
 * grouped by concern and documented with the rationale for each value.
 *
 * Design reference: VS Code uses a 1 000 ms debounce on file-change →
 * git status, followed by a 5 000 ms mandatory cooldown. Auto-fetch
 * defaults to 180 s. We adopt similar values where applicable.
 *
 * @see .reference/vscode/extensions/git/src/repository.ts — git status pipeline
 * @see .reference/vscode/extensions/git/src/autofetch.ts — auto-fetch period
 */

// ---------------------------------------------------------------------------
// PrWatcher — `gh pr view` polling
// ---------------------------------------------------------------------------

/** Polling interval when the workspace has an open panel. */
export const PR_VISIBLE_POLL_INTERVAL_MS = 5000

/**
 * Polling interval when the workspace has no open panel.
 * PR state changes on the order of minutes — 30 s is sufficient
 * for background freshness.
 */
export const PR_BACKGROUND_POLL_INTERVAL_MS = 30_000

// ---------------------------------------------------------------------------
// WorkspaceSyncService — `git status --branch` polling
// ---------------------------------------------------------------------------

/**
 * Polling interval for ahead/behind counts.
 * 15 s is a reasonable balance between freshness and subprocess cost.
 */
export const SYNC_STATUS_POLL_INTERVAL_MS = 15_000

// ---------------------------------------------------------------------------
// BackgroundFetchService — `git fetch --prune`
// ---------------------------------------------------------------------------

/** Default interval between background fetches. */
export const FETCH_INTERVAL_MS = 3_600_000 // 1 hour

/** Minimum interval the user can configure. */
export const FETCH_MINIMUM_INTERVAL_MS = 300_000 // 5 minutes

/**
 * Guard: skip fetch if FETCH_HEAD was modified more recently than
 * this threshold (another client or manual fetch already ran).
 */
export const FETCH_HEAD_GUARD_MS = 1_800_000 // 30 minutes

/** Random jitter upper bound to avoid thundering-herd on startup. */
export const FETCH_SKEW_UPPER_BOUND_MS = 30_000 // 30 seconds

// ---------------------------------------------------------------------------
// Repository watch coordinator — debounce & recovery
// ---------------------------------------------------------------------------

/**
 * Debounce for worktree reconciliation and branch refresh after
 * git-metadata file events.
 */
export const REPO_WATCH_DEBOUNCE_MS = 500

/** Delay before retrying a failed watcher subscription. */
export const REPO_WATCH_RECOVERY_MS = 1000

// ---------------------------------------------------------------------------
// Worktree watcher — legacy fs.watch debounce
// ---------------------------------------------------------------------------

/** Debounce for worktree watcher reconciliation triggers. */
export const WORKTREE_WATCHER_DEBOUNCE_MS = 500
