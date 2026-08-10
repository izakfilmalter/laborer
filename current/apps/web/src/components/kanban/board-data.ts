/**
 * Prototype-only board types and fake data for the kanban board.
 *
 * The shapes mirror the shared-db task row decided in the wayfinder map
 * (issues #351/#352/#353): stored statuses todo/in_progress/in_review/done/
 * cancelled, source execution/manual/slack_url, nullable slack permalink,
 * worktree binding by path, and a next-owned execution-status mirror that is
 * NOT a stored board status (failed/needs-attention cards stay In Progress).
 *
 * Throwaway: replaced by typed deltas over the RPC seam once the shared db
 * exists. Do not wire real persistence here.
 */

/** Stored board statuses. `cancelled` is stored but never rendered. */
export type BoardTaskStatus =
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'cancelled'

/** How the card came to exist. */
export type BoardTaskSource = 'execution' | 'manual' | 'slack_url'

/**
 * Next-owned mirror of an Execution's live state. Only meaningful for
 * `execution` cards sitting in In Progress; never moves the card itself.
 */
export type ExecutionMirror = 'running' | 'failed' | 'needs_attention' | null

/**
 * Prototype stand-in for "does the bound worktree exist on disk".
 * In the real board this is derived, not stored.
 */
export type WorktreeState = 'exists' | 'provisioning' | 'gone' | 'none'

export interface BoardPr {
  readonly number: number
  readonly state: 'open' | 'merged' | 'closed'
  readonly title: string
  readonly url: string
}

export interface BoardTask {
  readonly branch: string | null
  /** ISO timestamp — drives newest-first default ordering. */
  readonly createdAt: string
  readonly executionMirror: ExecutionMirror
  readonly id: string
  readonly pr: BoardPr | null
  /** Laborer root the card belongs to (per-project scoping key). */
  readonly rootPath: string
  /** May be NULL forever — cards must render without it. */
  readonly slackPermalink: string | null
  readonly source: BoardTaskSource
  readonly status: BoardTaskStatus
  /** Agent-authored (execution) or human-typed (manual/slack-url) title. */
  readonly title: string
  readonly worktreePath: string | null
  readonly worktreeState: WorktreeState
}

export interface BoardProject {
  readonly name: string
  readonly rootPath: string
}

export const FAKE_PROJECTS: readonly BoardProject[] = [
  { rootPath: '/Users/izak/Projects/laborer', name: 'laborer' },
  { rootPath: '/Users/izak/Projects/church-work', name: 'church-work' },
]

const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 3_600_000).toISOString()

const SLACK_URL = 'https://example.slack.com/archives/C0123/p1699999999'

/**
 * Fake cards covering every state the board must render:
 * all four columns, a failed and a needs-attention mirror badge, a NULL
 * slack permalink, a bot card whose worktree is still provisioning, a
 * worktree-gone card, and a cancelled card that must never appear.
 */
export const FAKE_TASKS: readonly BoardTask[] = [
  // ── Todo: only manual / slack-url cards can live here ──────────────
  {
    id: 't1',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'Tighten sidebar search debounce',
    status: 'todo',
    source: 'manual',
    slackPermalink: null,
    branch: null,
    worktreePath: null,
    worktreeState: 'none',
    executionMirror: null,
    pr: null,
    createdAt: hoursAgo(2),
  },
  {
    id: 't2',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'Fix flaky PR badge refresh reported in #eng-frontend',
    status: 'todo',
    source: 'slack_url',
    slackPermalink: SLACK_URL,
    branch: null,
    worktreePath: null,
    worktreeState: 'none',
    executionMirror: null,
    pr: null,
    createdAt: hoursAgo(26),
  },

  // ── In Progress: bot cards arrive here already executing ───────────
  {
    id: 't3',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'Deal with bug: duplicate toast when destroying a workspace',
    status: 'in_progress',
    source: 'execution',
    slackPermalink: SLACK_URL,
    branch: 'bug/duplicate-destroy-toast',
    worktreePath: '/Users/izak/Projects/laborer-worktrees/duplicate-toast',
    worktreeState: 'exists',
    executionMirror: 'running',
    pr: null,
    createdAt: hoursAgo(1),
  },
  {
    id: 't4',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'Create feature: per-project tray workspace counts',
    status: 'in_progress',
    source: 'execution',
    slackPermalink: SLACK_URL,
    branch: 'feature/tray-per-project',
    worktreePath: '/Users/izak/Projects/laborer-worktrees/tray-per-project',
    worktreeState: 'exists',
    executionMirror: 'needs_attention',
    pr: null,
    createdAt: hoursAgo(5),
  },
  {
    id: 't5',
    rootPath: '/Users/izak/Projects/laborer',
    // NULL slack permalink: the card must hold together without the link.
    title: 'Deal with bug: dashboard crash on empty repo',
    status: 'in_progress',
    source: 'execution',
    slackPermalink: null,
    branch: 'bug/dashboard-empty-repo',
    worktreePath: '/Users/izak/Projects/laborer-worktrees/dashboard-empty',
    worktreeState: 'exists',
    executionMirror: 'failed',
    pr: null,
    createdAt: hoursAgo(8),
  },
  {
    id: 't6',
    rootPath: '/Users/izak/Projects/laborer',
    // Bot card whose worktree hasn't been created on disk yet.
    title: 'Create feature: workspace auto-archive after merge',
    status: 'in_progress',
    source: 'execution',
    slackPermalink: SLACK_URL,
    branch: 'feature/auto-archive',
    worktreePath: '/Users/izak/Projects/laborer-worktrees/auto-archive',
    worktreeState: 'provisioning',
    executionMirror: 'running',
    pr: null,
    createdAt: hoursAgo(0.2),
  },

  // ── In Review: stored status, humans or PrWatcher move cards here ──
  {
    id: 't7',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'Refactor terminal spawn seam to be cwd-keyed',
    status: 'in_review',
    source: 'manual',
    slackPermalink: null,
    branch: 'refactor/cwd-spawn-seam',
    worktreePath: '/Users/izak/Projects/laborer-worktrees/cwd-spawn-seam',
    worktreeState: 'exists',
    executionMirror: null,
    pr: {
      number: 212,
      state: 'open',
      title: 'Refactor terminal spawn seam to be cwd-keyed',
      url: 'https://github.com/izakfilmalter/laborer/pull/212',
    },
    createdAt: hoursAgo(30),
  },
  {
    id: 't8',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'Create feature: slack-url intake for board cards',
    status: 'in_review',
    source: 'execution',
    slackPermalink: SLACK_URL,
    branch: 'feature/slack-url-intake',
    worktreePath: '/Users/izak/Projects/laborer-worktrees/slack-url-intake',
    worktreeState: 'exists',
    executionMirror: null,
    pr: {
      number: 208,
      state: 'open',
      title: 'Slack-url intake for board cards',
      url: 'https://github.com/izakfilmalter/laborer/pull/208',
    },
    createdAt: hoursAgo(50),
  },

  // ── Done ───────────────────────────────────────────────────────────
  {
    id: 't9',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'Deal with bug: worktree path escaping on spaces',
    status: 'done',
    source: 'execution',
    slackPermalink: SLACK_URL,
    branch: 'bug/worktree-path-escaping',
    worktreePath: '/Users/izak/Projects/laborer-worktrees/path-escaping',
    // The worktree was cleaned up after merge.
    worktreeState: 'gone',
    executionMirror: null,
    pr: {
      number: 199,
      state: 'merged',
      title: 'Escape worktree paths with spaces',
      url: 'https://github.com/izakfilmalter/laborer/pull/199',
    },
    createdAt: hoursAgo(70),
  },

  // ── Cancelled: stored, must NEVER render on the board ──────────────
  {
    id: 't10',
    rootPath: '/Users/izak/Projects/laborer',
    title: 'CANCELLED CARD — if you can read this the board is broken',
    status: 'cancelled',
    source: 'execution',
    slackPermalink: null,
    branch: 'spike/livestore-removal',
    worktreePath: null,
    worktreeState: 'none',
    executionMirror: null,
    pr: null,
    createdAt: hoursAgo(90),
  },

  // ── Second project: proves per-project scoping ─────────────────────
  {
    id: 't11',
    rootPath: '/Users/izak/Projects/church-work',
    title: 'Deal with bug: sub-task rows lose focus on reorder',
    status: 'in_progress',
    source: 'execution',
    slackPermalink: SLACK_URL,
    branch: 'bug/subtask-focus',
    worktreePath: '/Users/izak/Projects/church-work-worktrees/subtask-focus',
    worktreeState: 'exists',
    executionMirror: 'running',
    pr: null,
    createdAt: hoursAgo(3),
  },
  {
    id: 't12',
    rootPath: '/Users/izak/Projects/church-work',
    title: 'Add estimate rollups to the weekly view',
    status: 'todo',
    source: 'manual',
    slackPermalink: null,
    branch: null,
    worktreePath: null,
    worktreeState: 'none',
    executionMirror: null,
    pr: null,
    createdAt: hoursAgo(12),
  },
]
