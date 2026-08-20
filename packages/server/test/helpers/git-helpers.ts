import { execSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const createTempDir = (prefix: string, tempRoots?: string[]): string => {
  const dir = join(
    tmpdir(),
    `laborer-test-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  mkdirSync(dir, { recursive: true })
  // Resolve symlinks so macOS FSEvents delivers events reliably.
  // On macOS, tmpdir() returns a symlinked path (e.g. /var/folders/...)
  // that resolves to /private/var/folders/... — @parcel/watcher uses
  // FSEvents which operates on real paths, so the watched path must
  // match the canonical path for events to be delivered.
  const resolved = realpathSync(dir)
  tempRoots?.push(resolved)
  return resolved
}

export const git = (args: string, cwd: string): string =>
  execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim()

/**
 * Write a trigger file inside the `.git` directory to nudge macOS
 * FSEvents into delivering pending filesystem notifications.
 * FSEvents batches events and may hold them for hundreds of
 * milliseconds; writing a new file forces the batch to flush.
 */
export const nudgeGitWatcher = (repoPath: string): void => {
  writeFileSync(join(repoPath, '.git', `.watcher-nudge-${Date.now()}`), '')
}

export const initRepo = (prefix: string, tempRoots?: string[]): string => {
  const repoPath = createTempDir(prefix, tempRoots)
  // Name the branch rather than inheriting init.defaultBranch: these tests
  // push and assert against `main`, and a host configured for `master` would
  // fail them for a reason that has nothing to do with the behaviour.
  git('init -b main', repoPath)
  git('config user.email test@example.com', repoPath)
  git('config user.name Test User', repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# test\n')
  git('add README.md', repoPath)
  git('commit -m "initial"', repoPath)
  return repoPath
}
