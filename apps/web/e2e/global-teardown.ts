/**
 * Playwright Global Teardown
 *
 * Runs once after all E2E tests complete:
 * 1. Removes the temp git repository
 * 2. Cleans up the state file
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
  readonly tempRepoDir: string
}

export default function globalTeardown(_config: FullConfig): void {
  if (!existsSync(STATE_FILE)) {
    return
  }

  let state: SetupState
  try {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as SetupState
  } catch {
    return
  }

  // 1. Remove the temp git repository
  if (state.tempRepoDir && existsSync(state.tempRepoDir)) {
    rmSync(state.tempRepoDir, { recursive: true, force: true })
  }

  // 2. Clean up the state file
  rmSync(STATE_FILE, { force: true })
}
