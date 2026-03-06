/**
 * Playwright Global Teardown
 *
 * Runs once after all E2E tests complete:
 * 1. Kills the turbo dev process tree
 * 2. Removes the temp database directory
 * 3. Removes the temp git repository
 *
 * Reads state from the file written by global-setup.ts.
 *
 * @see PRD-e2e-test-coverage.md — Global Setup / Teardown
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FullConfig } from '@playwright/test'

/** Path to the state file shared between setup and teardown. */
const STATE_FILE = join(tmpdir(), 'laborer-e2e-state.json')

interface SetupState {
  readonly dataDirBase: string | null
  readonly servicesWereAlreadyRunning: boolean
  readonly tempRepoDir: string
  readonly turboPid: number | null
}

/**
 * Kill a process and all its children by process group.
 * Falls back to SIGKILL if SIGTERM doesn't work.
 */
function killProcessTree(pid: number): void {
  try {
    // Kill the process group (negative PID targets the group)
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      // Fallback: kill just the process
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process already exited — that's fine
    }
  }
}

export default async function globalTeardown(
  _config: FullConfig
): Promise<void> {
  if (!existsSync(STATE_FILE)) {
    return
  }

  let state: SetupState
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SetupState
  } catch {
    return
  }

  // 1. Kill the turbo dev process tree
  if (state.turboPid) {
    killProcessTree(state.turboPid)
    // Give processes time to shut down
    await new Promise((r) => setTimeout(r, 2000))
  }

  // 2. Remove the temp database directory
  if (state.dataDirBase && existsSync(state.dataDirBase)) {
    rmSync(state.dataDirBase, { recursive: true, force: true })
  }

  // 3. Remove the temp git repository
  if (state.tempRepoDir && existsSync(state.tempRepoDir)) {
    rmSync(state.tempRepoDir, { recursive: true, force: true })
  }

  // 4. Clean up the state file
  rmSync(STATE_FILE, { force: true })
}
