/**
 * Base-ref resolution — the single answer to "what did this branch fork from?"
 *
 * Two features need that answer and must not disagree about it: the PR
 * watcher, which simulates a merge against the base to tell you a branch
 * conflicts before GitHub does, and `file.diff`, which measures the branch's
 * whole change against the same fork point. A second ordering here would mean
 * the merge badge and the diff pane could describe different branches.
 *
 * The order is: whatever the task row recorded (the branch its PR targets,
 * else the branch it was cut from), then the remote's own idea of its default
 * branch, then the conventional local names. Nothing is hardcoded as the
 * answer — `main` is only ever the last guess, and failing to find one is a
 * value the caller has to handle rather than a silent default.
 *
 * The runner is injected because the two callers spawn git differently
 * (`spawnGit` versus the watcher's bare `spawn`); this module owns the
 * ordering, not the process handling.
 */

import { Effect } from 'effect'

/** The slice of a git invocation's result this module reads. */
export interface GitProbeResult {
  readonly exitCode: number
  readonly stdout: string
}

/** Runs a read-only git command in the worktree and never fails. */
export type GitProbe = (
  args: readonly string[]
) => Effect.Effect<GitProbeResult>

/**
 * Local branch names tried, in order, when nothing else names a base. `dev`
 * comes first because repositories that have both branch off `dev`.
 */
const CANDIDATE_BASE_BRANCHES = ['dev', 'main', 'master'] as const

const REMOTE_BRANCH_PREFIX = /^refs\/remotes\/[^/]+\//

/** `refs/remotes/origin/main` → `main`; anything else is returned as-is. */
export const shortBranchName = (ref: string): string =>
  ref.replace(REMOTE_BRANCH_PREFIX, '')

/**
 * Resolve the ref this worktree's branch should be measured against, or
 * `null` when the repository gives no answer — a fresh repo with no
 * `origin/HEAD` and none of the conventional branches.
 *
 * @param probe - runs git in the worktree
 * @param storedBaseBranch - the base a task row already recorded, if any
 */
export const resolveBaseRef = (
  probe: GitProbe,
  storedBaseBranch: string | null
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (storedBaseBranch !== null && storedBaseBranch.length > 0) {
      return storedBaseBranch
    }

    const remoteHead = yield* probe([
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
    ])
    if (remoteHead.exitCode === 0 && remoteHead.stdout.trim().length > 0) {
      return remoteHead.stdout.trim()
    }

    for (const candidate of CANDIDATE_BASE_BRANCHES) {
      const exists = yield* probe(['rev-parse', '--verify', candidate])
      if (exists.exitCode === 0) {
        return candidate
      }
    }

    return null
  })
