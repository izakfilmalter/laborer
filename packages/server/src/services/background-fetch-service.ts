/**
 * BackgroundFetchService — Effect Service
 *
 * Periodically runs `git fetch` for each active workspace so that local
 * tracking refs stay up-to-date. Without background fetching, the
 * ahead/behind counts reported by `git status --porcelain=v2 --branch`
 * only reflect the state of the local tracking refs, which become stale
 * as soon as the remote receives new commits.
 *
 * Modelled after GitHub Desktop's `BackgroundFetcher`:
 * - Queries the GitHub API for the server-recommended `x-poll-interval`
 * - Enforces a 5-minute minimum fetch interval (scheduler floor)
 * - Enforces a 30-minute minimum between actual fetches (FETCH_HEAD guard)
 * - Adds 0-30 seconds of random jitter to prevent client herding
 * - Per-repo deduplication: multiple workspaces in the same repo share
 *   one fetch schedule
 *
 * @see .reference/desktop/app/src/lib/stores/helpers/background-fetcher.ts
 */

import { statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tables } from '@laborer/shared/schema'
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  pipe,
  Ref,
} from 'effect'
import { spawn } from '../lib/spawn.js'
import { LaborerStore } from './laborer-store.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'

/**
 * Default interval when the GitHub API does not provide x-poll-interval.
 * Matches GitHub Desktop's `DefaultFetchInterval`.
 */
const DEFAULT_FETCH_INTERVAL_MS = 60 * 60 * 1000

/**
 * Minimum fetch interval to protect against the server sending an
 * aggressively low value. Matches GitHub Desktop's `MinimumInterval`.
 */
const MINIMUM_FETCH_INTERVAL_MS = 5 * 60 * 1000

/**
 * Minimum time between actual `git fetch` invocations for a given repo,
 * checked via FETCH_HEAD mtime. Matches GitHub Desktop's app-level guard.
 */
const FETCH_HEAD_GUARD_MS = 30 * 60 * 1000

/**
 * Upper bound for random jitter added to each interval to prevent
 * clients from syncing up. Matches GitHub Desktop's `SkewUpperBound`.
 */
const SKEW_UPPER_BOUND_MS = 30 * 1000

const GITHUB_HTTPS_REMOTE_REGEX =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
const GITHUB_SSH_REMOTE_REGEX = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/

/**
 * Memoized random skew, computed once per process lifetime.
 */
let cachedSkew: number | null = null

const getSkewMs = (): number => {
  if (cachedSkew !== null) {
    return cachedSkew
  }
  cachedSkew = Math.ceil(Math.random() * SKEW_UPPER_BOUND_MS)
  return cachedSkew
}

const parseGithubRepo = (
  remoteUrl: string
): { readonly owner: string; readonly repo: string } | null => {
  const trimmed = remoteUrl.trim()
  const httpsMatch = trimmed.match(GITHUB_HTTPS_REMOTE_REGEX)
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] }
  }
  const sshMatch = trimmed.match(GITHUB_SSH_REMOTE_REGEX)
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] }
  }
  return null
}

const getGithubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'laborer',
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  return headers
}

/**
 * Resolve the path to the FETCH_HEAD file for a given worktree.
 * For the main worktree this is `<root>/.git/FETCH_HEAD`.
 * For linked worktrees this is inside the common git directory.
 */
const resolveFetchHeadPath = (worktreePath: string): Effect.Effect<string> =>
  Effect.tryPromise({
    try: async () => {
      const proc = spawn(
        ['git', ...withFsmonitorDisabled(['rev-parse', '--git-common-dir'])],
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' }
      )
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        return join(worktreePath, '.git', 'FETCH_HEAD')
      }
      const stdout = await new Response(proc.stdout).text()
      const gitCommonDir = resolve(worktreePath, stdout.trim())
      return join(gitCommonDir, 'FETCH_HEAD')
    },
    catch: () => join(worktreePath, '.git', 'FETCH_HEAD'),
  }).pipe(Effect.orElseSucceed(() => join(worktreePath, '.git', 'FETCH_HEAD')))

/**
 * Read the mtime of FETCH_HEAD to determine when the last fetch occurred.
 * Returns null if the file does not exist.
 */
const getFetchHeadMtime = (fetchHeadPath: string): number | null => {
  try {
    return statSync(fetchHeadPath).mtimeMs
  } catch {
    return null
  }
}

/**
 * Resolve the remote origin URL for a worktree.
 */
const getRemoteOriginUrl = (
  worktreePath: string
): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: async () => {
      const proc = spawn(
        [
          'git',
          ...withFsmonitorDisabled(['config', '--get', 'remote.origin.url']),
        ],
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' }
      )
      const exitCode = await proc.exited
      if (exitCode !== 0) {
        return null
      }
      const stdout = await new Response(proc.stdout).text()
      return stdout.trim() || null
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * Query the GitHub API for the server-recommended poll interval.
 * Returns null if the request fails or the header is absent.
 */
const getGithubPollInterval = (
  owner: string,
  repo: string
): Effect.Effect<number | null> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/git`,
        {
          method: 'HEAD',
          headers: getGithubHeaders(),
        }
      )
      const header = response.headers.get('x-poll-interval')
      if (header === null) {
        return null
      }
      const seconds = Number.parseInt(header, 10)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return null
      }
      // Convert seconds to milliseconds
      return seconds * 1000
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null))

/**
 * Compute the fetch interval for a given repo, following GitHub Desktop's
 * logic: use the server-recommended interval clamped to the minimum,
 * or fall back to the default, then add the random skew.
 */
const computeFetchInterval = (serverIntervalMs: number | null): number => {
  const baseInterval =
    serverIntervalMs !== null
      ? Math.max(serverIntervalMs, MINIMUM_FETCH_INTERVAL_MS)
      : DEFAULT_FETCH_INTERVAL_MS
  return baseInterval + getSkewMs()
}

/**
 * Determine whether a fetch should actually be performed, based on
 * the FETCH_HEAD mtime guard. Matches GitHub Desktop's
 * `shouldBackgroundFetch` check.
 */
const shouldFetch = (fetchHeadPath: string): boolean => {
  const lastFetchMs = getFetchHeadMtime(fetchHeadPath)
  if (lastFetchMs === null) {
    // Never fetched — always fetch
    return true
  }
  return Date.now() - lastFetchMs >= FETCH_HEAD_GUARD_MS
}

/**
 * Run `git fetch --prune` in the given worktree directory.
 * Errors are logged and swallowed — background fetches are non-fatal.
 */
const performFetch = (worktreePath: string): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      const proc = spawn(
        ['git', ...withFsmonitorDisabled(['fetch', '--prune'])],
        { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' }
      )
      const exitCode = await proc.exited
      return exitCode === 0
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))

interface FetchScheduleState {
  /** Path to the FETCH_HEAD file for guard checks */
  readonly fetchHeadPath: string
  /** The fiber running the fetch loop */
  readonly fiber: Fiber.RuntimeFiber<void, never>
  /** Set of workspace IDs sharing this schedule */
  readonly workspaceIds: Set<string>
}

class BackgroundFetchService extends Context.Tag(
  '@laborer/BackgroundFetchService'
)<
  BackgroundFetchService,
  {
    /**
     * Start background fetching for a workspace. If another workspace
     * in the same repo is already being fetched, the workspace joins
     * the existing schedule.
     */
    readonly startFetching: (workspaceId: string) => Effect.Effect<void>
    /**
     * Stop background fetching for a workspace. The fetch schedule is
     * only stopped when the last workspace in a repo is removed.
     */
    readonly stopFetching: (workspaceId: string) => Effect.Effect<void>
    /** Stop all background fetch schedules. */
    readonly stopAllFetching: () => Effect.Effect<void>
    /**
     * Trigger an immediate fetch for the workspace's repo, bypassing
     * the interval schedule (but still respecting the FETCH_HEAD guard).
     */
    readonly fetchNow: (workspaceId: string) => Effect.Effect<boolean>
  }
>() {
  static readonly layer = Layer.scoped(
    BackgroundFetchService,
    Effect.gen(function* () {
      const { store } = yield* LaborerStore

      /**
       * Map from repo root path -> fetch schedule state.
       * Multiple workspaces in the same repo share one schedule.
       */
      const schedules = yield* Ref.make<Map<string, FetchScheduleState>>(
        new Map()
      )

      /**
       * Map from workspace ID -> repo root path, for reverse lookup
       * when stopping a workspace.
       */
      const workspaceToRepo = yield* Ref.make<Map<string, string>>(new Map())

      /**
       * Cache of resolved poll intervals per repo, so we only query
       * the GitHub API once per repo.
       */
      const pollIntervalCache = yield* Ref.make<Map<string, number>>(new Map())

      const getWorktreePath = (workspaceId: string): string | undefined => {
        const workspace = pipe(
          store.query(tables.workspaces),
          Arr.findFirst((ws) => ws.id === workspaceId)
        )
        return workspace._tag === 'Some'
          ? workspace.value.worktreePath
          : undefined
      }

      /**
       * Resolve the repo root for a worktree path. This is the
       * git common dir, which is shared across all worktrees in
       * the same repo.
       */
      const resolveRepoRoot = (worktreePath: string): Effect.Effect<string> =>
        Effect.tryPromise({
          try: async () => {
            const proc = spawn(
              [
                'git',
                ...withFsmonitorDisabled(['rev-parse', '--git-common-dir']),
              ],
              { cwd: worktreePath, stdout: 'pipe', stderr: 'pipe' }
            )
            const exitCode = await proc.exited
            const stdout = await new Response(proc.stdout).text()
            if (exitCode !== 0) {
              return worktreePath
            }
            return resolve(worktreePath, stdout.trim())
          },
          catch: () => worktreePath,
        }).pipe(Effect.orElseSucceed(() => worktreePath))

      /**
       * Determine the poll interval for a repo. Queries the GitHub API
       * for x-poll-interval on first call, then caches the result.
       */
      const resolveInterval = Effect.fn(
        'BackgroundFetchService.resolveInterval'
      )(function* (worktreePath: string, repoRoot: string) {
        // Check cache first
        const cached = yield* Ref.get(pollIntervalCache)
        const existing = cached.get(repoRoot)
        if (existing !== undefined) {
          return existing
        }

        // Resolve the remote URL and query GitHub API
        const remoteUrl = yield* getRemoteOriginUrl(worktreePath)
        let serverInterval: number | null = null

        if (remoteUrl !== null) {
          const repoInfo = parseGithubRepo(remoteUrl)
          if (repoInfo !== null) {
            serverInterval = yield* getGithubPollInterval(
              repoInfo.owner,
              repoInfo.repo
            )
          }
        }

        const interval = computeFetchInterval(serverInterval)

        yield* Ref.update(pollIntervalCache, (cache) => {
          const next = new Map(cache)
          next.set(repoRoot, interval)
          return next
        })

        return interval
      })

      /**
       * The fetch loop for a single repo. Runs an initial fetch
       * (with optional skew), then repeats on the resolved interval.
       */
      const fetchLoop = Effect.fn('BackgroundFetchService.fetchLoop')(
        function* (worktreePath: string, repoRoot: string) {
          const fetchHeadPath = yield* resolveFetchHeadPath(worktreePath)
          const intervalMs = yield* resolveInterval(worktreePath, repoRoot)

          // Initial skew delay to prevent all repos from fetching simultaneously
          yield* Effect.sleep(Duration.millis(getSkewMs()))

          // Run the fetch loop
          while (true) {
            if (shouldFetch(fetchHeadPath)) {
              yield* performFetch(worktreePath)
            }
            yield* Effect.sleep(Duration.millis(intervalMs))
          }
        }
      )

      const startFetching = Effect.fn('BackgroundFetchService.startFetching')(
        function* (workspaceId: string) {
          const worktreePath = getWorktreePath(workspaceId)
          if (worktreePath === undefined) {
            return
          }

          const repoRoot = yield* resolveRepoRoot(worktreePath)

          // Check if there's already a schedule for this repo
          const currentSchedules = yield* Ref.get(schedules)
          const existingSchedule = currentSchedules.get(repoRoot)

          if (existingSchedule !== undefined) {
            // Join the existing schedule
            existingSchedule.workspaceIds.add(workspaceId)
            yield* Ref.update(workspaceToRepo, (map) => {
              const next = new Map(map)
              next.set(workspaceId, repoRoot)
              return next
            })
            return
          }

          // Start a new fetch schedule for this repo
          const fetchHeadPath = yield* resolveFetchHeadPath(worktreePath)
          const fiber = yield* fetchLoop(worktreePath, repoRoot).pipe(
            Effect.asVoid,
            Effect.forkDaemon
          )

          yield* Ref.update(schedules, (map) => {
            const next = new Map(map)
            next.set(repoRoot, {
              fiber,
              fetchHeadPath,
              workspaceIds: new Set([workspaceId]),
            })
            return next
          })

          yield* Ref.update(workspaceToRepo, (map) => {
            const next = new Map(map)
            next.set(workspaceId, repoRoot)
            return next
          })
        }
      )

      const stopFetching = Effect.fn('BackgroundFetchService.stopFetching')(
        function* (workspaceId: string) {
          const repoRoot = yield* Ref.modify(workspaceToRepo, (map) => {
            const root = map.get(workspaceId)
            const next = new Map(map)
            next.delete(workspaceId)
            return [root, next] as const
          })

          if (repoRoot === undefined) {
            return
          }

          const schedule = yield* Ref.modify(schedules, (map) => {
            const existing = map.get(repoRoot)
            if (existing === undefined) {
              return [undefined, map] as const
            }

            existing.workspaceIds.delete(workspaceId)

            // Only stop the schedule when the last workspace leaves
            if (existing.workspaceIds.size > 0) {
              return [undefined, map] as const
            }

            const next = new Map(map)
            next.delete(repoRoot)
            return [existing, next] as const
          })

          if (schedule !== undefined) {
            yield* Fiber.interrupt(schedule.fiber)

            // Clear the cached interval for this repo
            yield* Ref.update(pollIntervalCache, (cache) => {
              const next = new Map(cache)
              next.delete(repoRoot)
              return next
            })
          }
        }
      )

      const stopAllFetching = Effect.fn(
        'BackgroundFetchService.stopAllFetching'
      )(function* () {
        const allSchedules = yield* Ref.getAndSet(schedules, new Map())
        yield* Effect.forEach(
          [...allSchedules.values()],
          (s) => Fiber.interrupt(s.fiber),
          { discard: true }
        )
        yield* Ref.set(workspaceToRepo, new Map())
        yield* Ref.set(pollIntervalCache, new Map())
      })

      const fetchNow = Effect.fn('BackgroundFetchService.fetchNow')(function* (
        workspaceId: string
      ) {
        const worktreePath = getWorktreePath(workspaceId)
        if (worktreePath === undefined) {
          return false
        }

        const fetchHeadPath = yield* resolveFetchHeadPath(worktreePath)
        if (!shouldFetch(fetchHeadPath)) {
          return false
        }

        return yield* performFetch(worktreePath)
      })

      yield* Effect.addFinalizer(() => stopAllFetching())

      return BackgroundFetchService.of({
        startFetching,
        stopFetching,
        stopAllFetching,
        fetchNow,
      })
    })
  )
}

export { BackgroundFetchService }
