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

import { existsSync, rmSync } from 'node:fs'
import type { FullConfig } from '@playwright/test'
import { getStateFile, readSetupState } from './global-setup.js'

export default function globalTeardown(_config: FullConfig): void {
  const stateFile = getStateFile()
  if (!existsSync(stateFile)) {
    return
  }

  let tempRepoDir: string | undefined
  try {
    tempRepoDir = readSetupState().tempRepoDir
  } catch {
    // The invocation-scoped state file is still safe to remove if corrupt.
  }

  // 1. Remove the temp git repository
  if (tempRepoDir && existsSync(tempRepoDir)) {
    rmSync(tempRepoDir, { recursive: true, force: true })
  }

  // 2. Clean up the state file
  rmSync(stateFile, { force: true })
}
