import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcError } from '@laborer/shared/rpc'
import {
  decodeSourceControlWritingSettings,
  SOURCE_CONTROL_WRITING_SETTING_KEY,
} from '@laborer/shared/source-control-writing'
import { Context, Duration, Effect, Fiber, Layer, Ref, Schedule } from 'effect'
import { spawn } from '../lib/spawn.js'
import { BackgroundFetchService } from './background-fetch-service.js'
import { LaborerDatabase } from './laborer-database.js'
import { SYNC_STATUS_POLL_INTERVAL_MS } from './polling-intervals.js'
import { PrWatcher } from './pr-watcher.js'
import { withFsmonitorDisabled } from './repo-watching-git.js'
import {
  generateCommitMessage,
  generatePrContent,
  PR_TEMPLATE_PATHS,
  resolveWritingPolicy,
} from './source-control-text-generation.js'
import {
  findWorkspaceRecord,
  listWorkspaceRecords,
} from './workspace-records.js'

interface WorkspaceSyncStatus {
  readonly aheadCount: number | null
  readonly behindCount: number | null
  readonly hasChanges: boolean
  readonly hasUpstream: boolean
}

/** The pull request a workspace's branch just gained, as the UI reads it. */
interface PullRequestSummary {
  readonly number: number | null
  readonly state: string | null
  readonly title: string | null
  readonly url: string | null
}

const BRANCH_AB_RE = /^# branch\.ab \+(\d+) -(\d+)$/u
const LINE_SPLIT_RE = /\r?\n/u

/**
 * Every porcelain v2 line that is not a `# header` describes a path the
 * worktree has moved away from HEAD — a change, a rename, an unmerged path,
 * or an untracked file. Counting them is how "is there anything to commit"
 * is answered without a second git call.
 */
const hasWorktreeChanges = (lines: readonly string[]): boolean =>
  lines.some((line) => line.length > 0 && !line.startsWith('#'))

const parseSyncStatus = (output: string): WorkspaceSyncStatus => {
  const lines = output.split(LINE_SPLIT_RE)
  const hasUpstream = lines.some((line) =>
    line.startsWith('# branch.upstream ')
  )
  const hasChanges = hasWorktreeChanges(lines)

  if (!hasUpstream) {
    return {
      aheadCount: null,
      behindCount: null,
      hasChanges,
      hasUpstream: false,
    }
  }

  for (const line of lines) {
    const match = BRANCH_AB_RE.exec(line)
    if (!match) {
      continue
    }

    const aheadCount = Number(match[1])
    const behindCount = Number(match[2])

    return {
      aheadCount: Number.isFinite(aheadCount) ? aheadCount : 0,
      behindCount: Number.isFinite(behindCount) ? behindCount : 0,
      hasChanges,
      hasUpstream: true,
    }
  }

  return {
    aheadCount: 0,
    behindCount: 0,
    hasChanges,
    hasUpstream: true,
  }
}

interface CommandResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

const spawnCommand = async (
  command: readonly string[],
  cwd: string
): Promise<CommandResult> => {
  const proc = spawn([...command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  return { exitCode, stdout, stderr }
}

const spawnGit = (
  args: readonly string[],
  cwd: string
): Promise<CommandResult> =>
  spawnCommand(['git', ...withFsmonitorDisabled(args)], cwd)

/** How many recent subjects it takes to hear a repository's commit voice. */
const RECENT_COMMIT_SUBJECT_COUNT = 20

/** The base branch assumed when even the remote will not say. */
const LAST_RESORT_BASE_BRANCH = 'main'

const ORIGIN_HEAD_PREFIX = 'origin/'

/**
 * Read git output for prompt context, treating failure as absence.
 *
 * None of these reads are load-bearing: a repository with no commits, no
 * upstream, or no template still has to be able to produce a commit message.
 * A missing section just means the model has less to go on.
 */
const readGitText = async (
  args: readonly string[],
  cwd: string
): Promise<string> => {
  const result = await spawnGit(args, cwd).catch(() => null)
  return result === null || result.exitCode !== 0 ? '' : result.stdout
}

const readRecentCommitSubjects = async (
  cwd: string
): Promise<readonly string[]> => {
  const output = await readGitText(
    [
      'log',
      '-n',
      String(RECENT_COMMIT_SUBJECT_COUNT),
      '--no-merges',
      '--pretty=format:%s',
    ],
    cwd
  )
  return output
    .split(LINE_SPLIT_RE)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * The branch a pull request should target when the workspace has not recorded
 * one of its own.
 *
 * Asked of the remote rather than assumed, because "main" is a convention and
 * not a fact — this repository's own default is `master`, and guessing wrong
 * makes `gh pr create` fail with "Base ref must be a branch" after the work is
 * already pushed.
 */
const resolveDefaultBaseBranch = async (cwd: string): Promise<string> => {
  const symbolic = await readGitText(
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    cwd
  )
  const branch = symbolic.trim()
  return branch.startsWith(ORIGIN_HEAD_PREFIX)
    ? branch.slice(ORIGIN_HEAD_PREFIX.length)
    : LAST_RESORT_BASE_BRANCH
}

/**
 * The ref a pull request's diff should be measured against.
 *
 * `origin/<base>` is preferred because that is what GitHub will compare
 * against; a local base branch is the fallback for a repository whose
 * tracking refs have not been fetched. When neither resolves the caller is
 * left with commits alone, which is still enough to describe the change.
 */
const resolveBaseRangeRef = async (
  cwd: string,
  baseBranch: string
): Promise<string | null> => {
  for (const candidate of [`origin/${baseBranch}`, baseBranch]) {
    const result = await spawnGit(
      ['rev-parse', '--verify', '--quiet', candidate],
      cwd
    ).catch(() => null)
    if (result !== null && result.exitCode === 0) {
      return candidate
    }
  }
  return null
}

/**
 * The repository's pull request template, if it keeps one.
 *
 * Read from the worktree rather than from git, because the operator is about
 * to open a pull request from exactly these files.
 */
const readPrTemplate = async (cwd: string): Promise<string | null> => {
  for (const candidate of PR_TEMPLATE_PATHS) {
    const contents = await readFile(join(cwd, candidate), 'utf8').catch(
      () => null
    )
    if (contents !== null && contents.trim() !== '') {
      return contents
    }
  }
  return null
}

class WorkspaceSyncService extends Context.Service<
  WorkspaceSyncService,
  {
    readonly checkStatus: (
      workspaceId: string
    ) => Effect.Effect<WorkspaceSyncStatus, RpcError>
    /**
     * Commit the worktree. An omitted message means the model writes one.
     */
    readonly commit: (
      workspaceId: string,
      message?: string | undefined
    ) => Effect.Effect<WorkspaceSyncStatus, RpcError>
    readonly createPullRequest: (
      workspaceId: string
    ) => Effect.Effect<PullRequestSummary, RpcError>
    readonly pull: (
      workspaceId: string
    ) => Effect.Effect<WorkspaceSyncStatus, RpcError>
    readonly push: (
      workspaceId: string
    ) => Effect.Effect<WorkspaceSyncStatus, RpcError>
    readonly startPolling: (
      workspaceId: string,
      intervalMs?: number
    ) => Effect.Effect<void>
    readonly stopPolling: (workspaceId: string) => Effect.Effect<void>
    readonly stopAllPolling: () => Effect.Effect<void>
  }
>()('@laborer/WorkspaceSyncService') {
  static readonly layer = Layer.effect(
    WorkspaceSyncService,
    Effect.gen(function* () {
      const laborerDatabase = yield* LaborerDatabase
      const prWatcher = yield* PrWatcher
      const backgroundFetch = yield* BackgroundFetchService

      const pollingFibers = yield* Ref.make<
        Map<string, Fiber.Fiber<void, never>>
      >(new Map())
      /**
       * Workspaces whose repo already has a background fetch schedule, so a
       * repeated status read does not re-resolve the repo root every time.
       */
      const fetchedWorkspaces = yield* Ref.make<Set<string>>(new Set())

      const getWorkspace = Effect.fn('WorkspaceSyncService.getWorkspace')(
        function* (workspaceId: string) {
          const workspace = yield* laborerDatabase.read(
            'find workspace for sync operation',
            (database) => findWorkspaceRecord(database, workspaceId)
          )

          if (workspace === null) {
            return yield* new RpcError({
              code: 'WORKSPACE_NOT_FOUND',
              message: `Workspace not found: ${workspaceId}`,
            })
          }

          return workspace
        }
      )

      /**
       * Ahead/behind counts are only as fresh as the repo's tracking refs, so
       * asking for a workspace's status enrolls its repo in background
       * fetching. Schedules are deduplicated per repo, and the main checkout
       * enrolls itself here because it has no task row to provision one.
       */
      const ensureBackgroundFetch = Effect.fn(
        'WorkspaceSyncService.ensureBackgroundFetch'
      )(function* (workspaceId: string) {
        const alreadyFetching = yield* Ref.modify(
          fetchedWorkspaces,
          (workspaces) => {
            if (workspaces.has(workspaceId)) {
              return [true, workspaces] as const
            }
            const next = new Set(workspaces)
            next.add(workspaceId)
            return [false, next] as const
          }
        )

        if (alreadyFetching) {
          return
        }

        yield* backgroundFetch.startFetching(workspaceId)
      })

      const checkStatus = Effect.fn('WorkspaceSyncService.checkStatus')(
        function* (workspaceId: string) {
          const workspace = yield* getWorkspace(workspaceId)
          yield* ensureBackgroundFetch(workspaceId)

          const result = yield* Effect.tryPromise({
            try: () =>
              spawnGit(
                ['status', '--porcelain=v2', '--branch'],
                workspace.worktreePath
              ),
            catch: (error) =>
              new RpcError({
                code: 'GIT_SYNC_STATUS_FAILED',
                message: `Failed to read sync status: ${String(error)}`,
              }),
          })

          if (result.exitCode !== 0) {
            return yield* new RpcError({
              code: 'GIT_SYNC_STATUS_FAILED',
              message: result.stderr.trim() || 'git status failed',
            })
          }

          return parseSyncStatus(result.stdout)
        }
      )

      const push = Effect.fn('WorkspaceSyncService.push')(function* (
        workspaceId: string
      ) {
        const workspace = yield* getWorkspace(workspaceId)
        // A branch created here has never been pushed, so a plain `git push`
        // would fail on the missing upstream. Publishing it is the same
        // intent the operator expressed, so the first push sets the tracking
        // ref rather than asking them to name it.
        const current = yield* checkStatus(workspaceId)
        const pushArgs = current.hasUpstream
          ? ['push']
          : ['push', '-u', 'origin', 'HEAD']

        const result = yield* Effect.tryPromise({
          try: () => spawnGit(pushArgs, workspace.worktreePath),
          catch: (error) =>
            new RpcError({
              code: 'GIT_PUSH_FAILED',
              message: `Failed to push commits: ${String(error)}`,
            }),
        })

        if (result.exitCode !== 0) {
          return yield* new RpcError({
            code: 'GIT_PUSH_FAILED',
            message: result.stderr.trim() || 'git push failed',
          })
        }

        const status = yield* checkStatus(workspaceId)
        yield* prWatcher.checkPr(workspaceId).pipe(Effect.ignore)
        return status
      })

      const pull = Effect.fn('WorkspaceSyncService.pull')(function* (
        workspaceId: string
      ) {
        const workspace = yield* getWorkspace(workspaceId)

        const result = yield* Effect.tryPromise({
          try: () => spawnGit(['pull', '--ff-only'], workspace.worktreePath),
          catch: (error) =>
            new RpcError({
              code: 'GIT_PULL_FAILED',
              message: `Failed to pull commits: ${String(error)}`,
            }),
        })

        if (result.exitCode !== 0) {
          return yield* new RpcError({
            code: 'GIT_PULL_FAILED',
            message: result.stderr.trim() || 'git pull failed',
          })
        }

        return yield* checkStatus(workspaceId)
      })

      /**
       * The operator's writing preferences, or the defaults when they have
       * never opened settings. Read per call so a change lands on the next
       * commit without restarting the daemon.
       */
      const readWritingSettings = Effect.fn(
        'WorkspaceSyncService.readWritingSettings'
      )(function* () {
        const stored = yield* laborerDatabase.read(
          'read source control writing settings',
          (database) => database.findSetting(SOURCE_CONTROL_WRITING_SETTING_KEY)
        )
        return decodeSourceControlWritingSettings(stored?.value)
      })

      /**
       * Ask the model to name the staged change.
       *
       * Everything it reads comes from `--cached`, so the message describes
       * the commit that is about to be made and nothing else in the worktree.
       */
      const writeCommitMessage = Effect.fn(
        'WorkspaceSyncService.writeCommitMessage'
      )(function* (worktreePath: string) {
        const settings = yield* readWritingSettings()
        const context = yield* Effect.promise(async () => {
          const [branch, stagedSummary, stagedPatch, recentSubjects] =
            await Promise.all([
              readGitText(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath),
              readGitText(['diff', '--cached', '--name-status'], worktreePath),
              readGitText(
                ['diff', '--no-ext-diff', '--cached', '--patch', '--minimal'],
                worktreePath
              ),
              readRecentCommitSubjects(worktreePath),
            ])
          return { branch, recentSubjects, stagedPatch, stagedSummary }
        })

        return yield* generateCommitMessage({
          branch: context.branch.trim() === '' ? null : context.branch.trim(),
          cwd: worktreePath,
          model: settings.model,
          policy: resolveWritingPolicy(settings, context.recentSubjects),
          stagedPatch: context.stagedPatch,
          stagedSummary: context.stagedSummary,
        })
      })

      /**
       * Commit everything the worktree has moved, under one message.
       *
       * Mission control has no staging area to speak of: the operator reviews
       * a workspace's whole diff and then decides to keep it, so partial
       * staging is a concept this surface never offers. `git add -A` makes the
       * commit mean exactly what the diff pane showed.
       *
       * With no message supplied, the staged diff is handed to a model and it
       * writes one. Staging first is what makes that possible: `--cached`
       * reads exactly the change about to be committed, so the message can
       * never describe something the commit leaves out.
       */
      const commit = Effect.fn('WorkspaceSyncService.commit')(function* (
        workspaceId: string,
        message?: string | undefined
      ) {
        const workspace = yield* getWorkspace(workspaceId)

        const staged = yield* Effect.tryPromise({
          try: () => spawnGit(['add', '-A'], workspace.worktreePath),
          catch: (error) =>
            new RpcError({
              code: 'GIT_COMMIT_FAILED',
              message: `Failed to stage changes: ${String(error)}`,
            }),
        })

        if (staged.exitCode !== 0) {
          return yield* new RpcError({
            code: 'GIT_COMMIT_FAILED',
            message: staged.stderr.trim() || 'git add failed',
          })
        }

        const commitMessage =
          message !== undefined && message.trim() !== ''
            ? message.trim()
            : yield* writeCommitMessage(workspace.worktreePath)

        const result = yield* Effect.tryPromise({
          try: () =>
            spawnGit(['commit', '-m', commitMessage], workspace.worktreePath),
          catch: (error) =>
            new RpcError({
              code: 'GIT_COMMIT_FAILED',
              message: `Failed to commit changes: ${String(error)}`,
            }),
        })

        if (result.exitCode !== 0) {
          return yield* new RpcError({
            code: 'GIT_COMMIT_FAILED',
            message:
              result.stderr.trim() ||
              result.stdout.trim() ||
              'git commit failed',
          })
        }

        return yield* checkStatus(workspaceId)
      })

      /**
       * Ask the model to describe the branch as a pull request.
       *
       * The whole branch is the subject here, not one commit: the range
       * against the base branch is what a reviewer will actually read. When a
       * repository ships a pull request template, the body is asked to fill
       * it in rather than to invent its own headings.
       */
      const writePrContent = Effect.fn('WorkspaceSyncService.writePrContent')(
        function* (worktreePath: string, baseBranch: string) {
          const settings = yield* readWritingSettings()
          const context = yield* Effect.promise(async () => {
            const rangeRef = await resolveBaseRangeRef(worktreePath, baseBranch)
            const range = rangeRef === null ? null : `${rangeRef}..HEAD`
            const [
              headBranch,
              commitSummary,
              diffSummary,
              diffPatch,
              recentSubjects,
              prTemplate,
            ] = await Promise.all([
              readGitText(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath),
              readGitText(
                range === null
                  ? ['log', '--oneline', '-n', '20']
                  : ['log', '--oneline', range],
                worktreePath
              ),
              range === null
                ? Promise.resolve('')
                : readGitText(['diff', '--stat', range], worktreePath),
              range === null
                ? Promise.resolve('')
                : readGitText(
                    ['diff', '--no-ext-diff', '--patch', '--minimal', range],
                    worktreePath
                  ),
              readRecentCommitSubjects(worktreePath),
              settings.followPrTemplate
                ? readPrTemplate(worktreePath)
                : Promise.resolve(null),
            ])
            return {
              commitSummary,
              diffPatch,
              diffSummary,
              headBranch,
              prTemplate,
              recentSubjects,
            }
          })

          return yield* generatePrContent({
            baseBranch,
            commitSummary: context.commitSummary,
            cwd: worktreePath,
            diffPatch: context.diffPatch,
            diffSummary: context.diffSummary,
            headBranch:
              context.headBranch.trim() === ''
                ? '(detached)'
                : context.headBranch.trim(),
            model: settings.model,
            policy: resolveWritingPolicy(settings, context.recentSubjects),
            prTemplate: context.prTemplate,
          })
        }
      )

      /**
       * Open a pull request for whatever the worktree currently has checked
       * out, using the GitHub CLI the PR watcher already reads through.
       *
       * The title and body are written by a model from the branch's range
       * against its base, rather than taken from the commits with `--fill`.
       * The commits were themselves generated one diff at a time and read as
       * a changelog, not as a description of the change as a whole — which is
       * what a reviewer opening the pull request needs. The branch has to be
       * pushed first, which is why the button runs push ahead of this step.
       */
      const createPullRequest = Effect.fn(
        'WorkspaceSyncService.createPullRequest'
      )(function* (workspaceId: string) {
        const workspace = yield* getWorkspace(workspaceId)
        const baseBranch =
          workspace.baseBranch ??
          (yield* Effect.promise(() =>
            resolveDefaultBaseBranch(workspace.worktreePath)
          ))
        const content = yield* writePrContent(
          workspace.worktreePath,
          baseBranch
        )

        // The body goes through a file because a generated description is
        // markdown with newlines, and argv is the wrong place for it.
        const result = yield* Effect.acquireUseRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'laborer-pr-'))),
          (directory) =>
            Effect.tryPromise({
              try: async () => {
                const bodyFile = join(directory, 'body.md')
                await writeFile(bodyFile, content.body, 'utf8')
                return await spawnCommand(
                  [
                    'gh',
                    'pr',
                    'create',
                    '--base',
                    baseBranch,
                    '--title',
                    content.title,
                    '--body-file',
                    bodyFile,
                  ],
                  workspace.worktreePath
                )
              },
              catch: (error) =>
                new RpcError({
                  code: 'GH_PR_CREATE_FAILED',
                  message: `Failed to create pull request: ${String(error)}`,
                }),
            }),
          (directory) =>
            Effect.promise(() =>
              rm(directory, { force: true, recursive: true }).catch(
                () => undefined
              )
            )
        )

        if (result.exitCode !== 0) {
          return yield* new RpcError({
            code: 'GH_PR_CREATE_FAILED',
            message:
              result.stderr.trim() ||
              result.stdout.trim() ||
              'gh pr create failed',
          })
        }

        // The created pull request is read back through the watcher rather
        // than parsed out of the CLI's output, so the row the rest of the app
        // reads and the answer this call returns are the same fact.
        const prData = yield* prWatcher.checkPr(workspaceId)

        return {
          number: prData.number,
          state: prData.state,
          title: prData.title,
          url: prData.url,
        } satisfies PullRequestSummary
      })

      const startPolling = Effect.fn('WorkspaceSyncService.startPolling')(
        function* (workspaceId: string, intervalMs?: number) {
          const currentFibers = yield* Ref.get(pollingFibers)
          if (currentFibers.has(workspaceId)) {
            return
          }

          // Start background fetching so tracking refs stay fresh
          yield* ensureBackgroundFetch(workspaceId)

          const interval = intervalMs ?? SYNC_STATUS_POLL_INTERVAL_MS
          const fiber = yield* checkStatus(workspaceId).pipe(
            Effect.catch(() => Effect.void),
            Effect.repeat(Schedule.spaced(Duration.millis(interval))),
            Effect.asVoid,
            Effect.forkDetach
          )

          yield* Ref.update(pollingFibers, (fibers) => {
            const next = new Map(fibers)
            next.set(workspaceId, fiber)
            return next
          })
        }
      )

      const stopPolling = Effect.fn('WorkspaceSyncService.stopPolling')(
        function* (workspaceId: string) {
          const fiber = yield* Ref.modify(pollingFibers, (fibers) => {
            const existing = fibers.get(workspaceId)
            if (existing === undefined) {
              return [undefined, fibers] as const
            }
            const next = new Map(fibers)
            next.delete(workspaceId)
            return [existing, next] as const
          })

          if (fiber !== undefined) {
            yield* Fiber.interrupt(fiber)
          }

          // Stop background fetching for this workspace
          yield* backgroundFetch.stopFetching(workspaceId)

          yield* Ref.update(fetchedWorkspaces, (workspaces) => {
            const next = new Set(workspaces)
            next.delete(workspaceId)
            return next
          })
        }
      )

      const stopAllPolling = Effect.fn('WorkspaceSyncService.stopAllPolling')(
        function* () {
          const fibers = yield* Ref.getAndSet(pollingFibers, new Map())
          yield* Effect.forEach([...fibers.values()], Fiber.interrupt, {
            discard: true,
          })
          yield* backgroundFetch.stopAllFetching()
          yield* Ref.set(fetchedWorkspaces, new Set())
        }
      )

      const bootstrapPolling = Effect.fn(
        'WorkspaceSyncService.bootstrapPolling'
      )(function* () {
        const workspaces = yield* laborerDatabase.read(
          'list workspaces for sync polling',
          listWorkspaceRecords
        )

        yield* Effect.forEach(
          workspaces,
          (workspace) => startPolling(workspace.id),
          { discard: true }
        )
      })

      yield* Effect.forkDetach(
        bootstrapPolling().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('Workspace sync bootstrap failed', { cause })
          )
        )
      )
      yield* Effect.addFinalizer(() => stopAllPolling())

      return WorkspaceSyncService.of({
        checkStatus,
        commit,
        createPullRequest,
        pull,
        push,
        startPolling,
        stopPolling,
        stopAllPolling,
      })
    })
  )
}

export { resolveDefaultBaseBranch, WorkspaceSyncService }
