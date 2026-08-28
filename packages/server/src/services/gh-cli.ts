/**
 * Shared `gh` CLI plumbing for pull request reads and writes.
 *
 * Every caller runs `gh` inside a workspace worktree so authentication rides
 * on the user's existing GitHub login. The child process is acquired in a
 * scope: interrupting the calling fiber — a timeout, a closed pane — kills
 * the process instead of leaving it writing to a pipe nobody reads.
 *
 * Failures are values, not defects, so a missing `gh`, a revoked token, or a
 * deleted worktree can be turned into one RPC error by the caller.
 */

import { existsSync } from 'node:fs'
import { Effect } from 'effect'
import { spawn } from '../lib/spawn.js'

interface GhApiFailure {
  readonly _tag: 'GhApiFailure'
  readonly message: string
}

const ghApiFailure = (message: string): GhApiFailure => ({
  _tag: 'GhApiFailure',
  message,
})

/**
 * A workspace can outlive its directory, for example when its project is
 * removed. Node reports a missing cwd as `spawn gh ENOENT`, which reads like
 * a missing GitHub CLI unless the worktree is named explicitly.
 */
const missingWorktreeFailure = (worktreePath: string): GhApiFailure =>
  ghApiFailure(`Worktree no longer exists: ${worktreePath}`)

/** The directory can also disappear between the guard and the spawn. */
const spawnFailure = (
  worktreePath: string,
  label: string,
  error: unknown
): GhApiFailure =>
  existsSync(worktreePath)
    ? ghApiFailure(`Failed to run ${label}: ${String(error)}`)
    : missingWorktreeFailure(worktreePath)

interface GhOutput {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

/** One string as the child's stdin, closed once it is written. */
const streamOfText = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })

/**
 * Run `gh` in a worktree, holding the child process in a scope.
 *
 * The fiber running this is interrupted whenever the caller's timeout fires,
 * a sibling request fails, or the client closes the pane — and interrupting
 * a fiber does nothing to the OS process it started. Acquiring the process
 * in a scope makes the kill part of the fiber's unwinding instead.
 *
 * `label` names the request in failures, since the argument list is not
 * something to read back in an error message.
 *
 * `stdin` carries request bodies — comment text, GraphQL documents — so a
 * reader's own words never appear in argv, which is visible in process
 * listings and echoed back inside failure messages.
 */
const runGh = (
  worktreePath: string,
  args: readonly string[],
  label: string,
  options?: { readonly stdin?: string }
): Effect.Effect<GhOutput, GhApiFailure> =>
  Effect.gen(function* () {
    const proc = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(['gh', ...args], {
            cwd: worktreePath,
            stdout: 'pipe',
            stderr: 'pipe',
            ...(options?.stdin === undefined
              ? {}
              : { stdin: streamOfText(options.stdin) }),
          }),
        catch: (error) => spawnFailure(worktreePath, label, error),
      }),
      (spawned) => Effect.ignore(Effect.try(() => spawned.kill()))
    )

    return yield* Effect.tryPromise({
      try: async () => {
        const exitCode = await proc.exited
        const stdout = await new Response(proc.stdout).text()
        const stderr = await new Response(proc.stderr).text()

        return { exitCode, stderr, stdout }
      },
      catch: (error) => spawnFailure(worktreePath, label, error),
    })
  }).pipe(Effect.scoped)

/**
 * Run `gh` and demand a zero exit, failing with stderr — which is where the
 * CLI explains itself — or the exit code when it printed nothing.
 */
const runGhExpectingSuccess = (
  worktreePath: string,
  args: readonly string[],
  label: string,
  options?: { readonly stdin?: string }
): Effect.Effect<GhOutput, GhApiFailure> =>
  runGh(worktreePath, args, label, options).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result)
        : Effect.fail(
            ghApiFailure(
              result.stderr.trim() || `${label} exited with ${result.exitCode}`
            )
          )
    )
  )

export {
  ghApiFailure,
  missingWorktreeFailure,
  runGh,
  runGhExpectingSuccess,
  spawnFailure,
}
export type { GhApiFailure, GhOutput }
