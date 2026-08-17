import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const git = (args: readonly string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

export const initRepo = (prefix: string, tempRoots: string[]): string => {
  const repoPath = join(
    tmpdir(),
    `e${crypto.randomUUID().slice(0, 8)}-laborer-e2e-${prefix}-${Date.now()}`
  )
  mkdirSync(repoPath, { recursive: true })
  const canonicalRepoPath = realpathSync(repoPath)
  tempRoots.push(canonicalRepoPath)

  git(['init'], canonicalRepoPath)
  git(['config', 'user.email', 'test@example.com'], canonicalRepoPath)
  git(['config', 'user.name', 'E2E User'], canonicalRepoPath)
  writeFileSync(join(canonicalRepoPath, 'README.md'), '# test\n')
  git(['add', 'README.md'], canonicalRepoPath)
  git(['commit', '-m', 'initial'], canonicalRepoPath)

  return canonicalRepoPath
}
