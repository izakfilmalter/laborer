/**
 * Playwright Global Setup
 *
 * Runs once before all E2E tests:
 * 1. Creates a temp git repository with an initial commit (for project tests)
 * 2. Verifies that Electron and utility process builds exist
 *
 * The Electron app is launched per-test via the `electronApp` fixture
 * in test-fixtures.ts, not as a shared global process.
 *
 * Stores temp paths in a state file for teardown.
 *
 * @see PRD-e2e-test-coverage.md — Global Setup / Teardown
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FullConfig } from '@playwright/test'

/** Path to the state file shared between setup and teardown. */
const STATE_FILE = join(tmpdir(), 'laborer-e2e-state.json')

export default function globalSetup(_config: FullConfig): void {
  // 1. Create a temp git repository with an initial commit
  const tempRepoDir = mkdtempSync(join(tmpdir(), 'laborer-e2e-repo-'))
  execSync('git init', { cwd: tempRepoDir, stdio: 'pipe' })
  execSync("git config user.email 'e2e@test.local'", {
    cwd: tempRepoDir,
    stdio: 'pipe',
  })
  execSync("git config user.name 'E2E Test'", {
    cwd: tempRepoDir,
    stdio: 'pipe',
  })
  writeFileSync(join(tempRepoDir, 'README.md'), '# E2E Test Repo\n')
  writeFileSync(join(tempRepoDir, '.gitignore'), 'laborer.json\n')
  execSync('git add .', { cwd: tempRepoDir, stdio: 'pipe' })
  execSync('git commit -m "Initial commit"', {
    cwd: tempRepoDir,
    stdio: 'pipe',
  })

  // 2. Verify that Electron and utility process builds exist
  const monorepoRoot = resolve(import.meta.dirname, '../../..')
  const requiredBuilds = [
    join(monorepoRoot, 'apps/desktop/dist-electron/main.cjs'),
    join(monorepoRoot, 'apps/desktop/dist-electron/preload.cjs'),
    join(monorepoRoot, 'packages/server/dist/utility-main.mjs'),
    join(monorepoRoot, 'packages/terminal/dist/utility-main.mjs'),
  ]

  const missingBuilds = requiredBuilds.filter((path) => !existsSync(path))
  if (missingBuilds.length > 0) {
    throw new Error(
      `E2E setup: Missing required builds:\n${missingBuilds.join('\n')}\n\n` +
        'Run `turbo build` or `turbo dev` to build all packages first.'
    )
  }

  // 3. Save state for teardown and test access
  const state = {
    tempRepoDir,
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

  // Set env vars so tests can access the temp repo path
  process.env.E2E_TEMP_REPO_DIR = tempRepoDir
}
