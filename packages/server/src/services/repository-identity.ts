/**
 * RepositoryIdentity — Effect Service
 *
 * Resolves canonical repository metadata for any user-supplied path.
 * Uses git as the source of truth to determine the checkout root,
 * common git directory, and whether the path is the main checkout
 * or a linked worktree.
 *
 * All returned paths are canonicalized through realpath so that
 * symlinks and alternate path representations collapse to the same
 * identity. A stable repository identifier is derived from the
 * canonical upstream repository when one is configured, falling back to the
 * canonical common git directory for repositories without a remote.
 *
 * This service is the foundation for preventing duplicate project
 * registrations and for scoping watcher lifecycle to logical
 * repositories.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issue 1
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context, Data, Effect, Layer } from 'effect'
import { withFsmonitorDisabled } from './repo-watching-git.js'

/**
 * Metadata describing a canonical repository identity.
 */
export interface RepoIdentity {
  /** Canonical (realpath-resolved) path to the shared .git directory */
  readonly canonicalGitCommonDir: string
  /** Canonical (realpath-resolved) checkout root for the working tree */
  readonly canonicalRoot: string
  /** Whether the resolved path is the main checkout (true) or a linked worktree (false) */
  readonly isMainWorktree: boolean
  /** Stable identifier derived from the canonical common git directory */
  readonly repoId: string
}

class RepositoryIdentityError extends Data.TaggedError(
  'RepositoryIdentityError'
)<{
  readonly message: string
}> {}

const runGit = (
  args: readonly string[],
  cwd: string
): Effect.Effect<string, RepositoryIdentityError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolvePromise, rejectPromise) => {
        execFile(
          'git',
          withFsmonitorDisabled(args),
          { cwd },
          (error, stdout, stderr) => {
            if (error) {
              rejectPromise(
                new RepositoryIdentityError({
                  message: `git ${args.join(' ')} failed: ${stderr?.trim() || String(error)}`,
                })
              )
              return
            }

            resolvePromise(stdout.trim())
          }
        )
      }),
    catch: (cause) =>
      cause instanceof RepositoryIdentityError
        ? cause
        : new RepositoryIdentityError({ message: String(cause) }),
  })

const canonicalize = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Derive a stable, short repository identifier from the canonical
 * repository key. Uses SHA-256 truncated to 16 hex chars.
 */
const deriveRepoId = (repositoryKey: string): string => {
  const hash = createHash('sha256').update(repositoryKey).digest('hex')
  return hash.slice(0, 16)
}

const SCP_REMOTE_PATTERN = /^(?:[^@/]+@)?([^:/]+):(.+)$/
const GIT_SUFFIX_PATTERN = /\.git\/?$/
const TRAILING_SLASH_PATTERN = /\/$/

const trimRemotePath = (value: string): string =>
  value.replace(GIT_SUFFIX_PATTERN, '').replace(TRAILING_SLASH_PATTERN, '')

/** Collapse the common URL spellings for one git remote into one identity. */
const normalizeRemote = (remote: string): string => {
  const scp = SCP_REMOTE_PATTERN.exec(remote)
  if (scp && !remote.includes('://')) {
    return `${scp[1]?.toLowerCase()}/${trimRemotePath(scp[2] ?? '')}`
  }
  try {
    const url = new URL(remote)
    if (url.protocol === 'file:') {
      return `file:${trimRemotePath(canonicalize(url.pathname))}`
    }
    return `${url.hostname.toLowerCase()}${trimRemotePath(url.pathname)}`
  } catch {
    return trimRemotePath(canonicalize(remote))
  }
}

class RepositoryIdentity extends Context.Service<
  RepositoryIdentity,
  {
    /**
     * Resolve canonical repository identity for the given path.
     * The path can be a repo root, a nested directory inside a repo,
     * a symlinked path, or a linked worktree path.
     */
    readonly resolve: (
      inputPath: string
    ) => Effect.Effect<RepoIdentity, RepositoryIdentityError>
  }
>()('@laborer/RepositoryIdentity') {
  static readonly layer = Layer.effect(
    RepositoryIdentity,
    Effect.gen(function* () {
      const resolveIdentity = Effect.fn('RepositoryIdentity.resolve')(
        function* (inputPath: string) {
          // 1. Resolve to absolute path
          const absolutePath = resolve(inputPath)

          // 2. Validate the path exists and is a directory
          yield* Effect.try({
            try: () => {
              const s = statSync(absolutePath)
              if (!s.isDirectory()) {
                throw new Error('not a directory')
              }
            },
            catch: () =>
              new RepositoryIdentityError({
                message: `Path does not exist or is not a directory: ${absolutePath}`,
              }),
          })

          // 3. Get the toplevel (checkout root) for this working tree
          const rawToplevel = yield* runGit(
            ['rev-parse', '--show-toplevel'],
            absolutePath
          )
          const canonicalRoot = canonicalize(rawToplevel)

          // 4. Get the git common directory (shared across worktrees)
          const rawGitCommonDir = yield* runGit(
            ['rev-parse', '--git-common-dir'],
            absolutePath
          )
          // git-common-dir may be relative to cwd, so resolve against
          // the working directory before canonicalizing
          const canonicalGitCommonDir = canonicalize(
            resolve(absolutePath, rawGitCommonDir)
          )

          // 5. Determine if this is the main worktree
          // The main worktree's git dir lives inside the checkout root
          // (e.g., <root>/.git). Linked worktrees have a separate gitdir
          // file pointing to <commondir>/worktrees/<name>.
          const rawGitDir = yield* runGit(
            ['rev-parse', '--git-dir'],
            absolutePath
          )
          const canonicalGitDir = canonicalize(resolve(absolutePath, rawGitDir))
          const isMainWorktree = canonicalGitDir === canonicalGitCommonDir

          // 6. Prefer a clone-stable remote identity. Repositories without an
          // origin remain checkout-local, which is the only identity available.
          const origin = yield* runGit(
            ['remote', 'get-url', 'origin'],
            absolutePath
          ).pipe(Effect.option)
          const repositoryKey =
            origin._tag === 'Some'
              ? `remote:${normalizeRemote(origin.value)}`
              : `gitdir:${canonicalGitCommonDir}`
          const repoId = deriveRepoId(repositoryKey)

          return {
            canonicalRoot,
            canonicalGitCommonDir,
            repoId,
            isMainWorktree,
          } satisfies RepoIdentity
        }
      )

      return RepositoryIdentity.of({ resolve: resolveIdentity })
    })
  )
}

export { RepositoryIdentity, RepositoryIdentityError }
