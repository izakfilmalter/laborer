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

/**
 * Polling interval when the workspace has an open panel.
 *
 * Design reference: GitHub Desktop. Its CommitStatusStore refreshes check
 * status every 3 min, and the GitHub API serves PR reads with a 60 s
 * max-age, so polling faster than 60 s returns cached responses and only
 * burns battery and rate limit.
 */
export const PR_VISIBLE_POLL_INTERVAL_MS = 60_000

/**
 * Polling interval when the workspace has no open panel.
 *
 * Design reference: GitHub Desktop's PullRequestUpdater polls every 30 min
 * (2 min enforced minimum) and is gated on window focus. PR state changes
 * on the order of minutes; 5 min keeps background freshness while staying
 * well inside those bounds.
 */
export const PR_BACKGROUND_POLL_INTERVAL_MS = 300_000

/**
 * Bound on one `gh api graphql` read of a pull request's review threads.
 *
 * The poll loop is sequential — check, then sleep — so a `gh` that never
 * exits would stop PR polling for that workspace outright, taking check
 * status and mergeability down with a count nobody would miss. 10 s is an
 * order of magnitude past a healthy round trip; past it the last known
 * count is held and the next tick tries again.
 */
export const PR_REVIEW_THREADS_TIMEOUT_MS = 10_000

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

/** Minimum delay between full worktree reconciliations for one project. */
export const REPO_WATCH_RECONCILE_COOLDOWN_MS = 5000

/** Delay before retrying a failed watcher subscription. */
export const REPO_WATCH_RECOVERY_MS = 1000

// ---------------------------------------------------------------------------
// Worktree watcher — legacy fs.watch debounce
// ---------------------------------------------------------------------------

/** Debounce for worktree watcher reconciliation triggers. */
export const WORKTREE_WATCHER_DEBOUNCE_MS = 500
