export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const waitFor = async (
  assertion: () => Promise<boolean>,
  timeoutMs = 10_000,
  label?: string
): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await assertion()) {
      return
    }
    await delay(100)
  }
  const suffix = label !== undefined ? `: ${label}` : ''
  throw new Error(`Timed out waiting for condition${suffix}`)
}

/**
 * Like `waitFor` but periodically touches files in the given `.git`
 * directory to nudge macOS FSEvents into flushing pending event
 * batches. Use this when waiting for conditions that depend on
 * filesystem watcher event delivery.
 *
 * Nudges every 500ms by writing a small trigger file and touching
 * the git directory's mtime via `utimesSync`.
 */
export const waitForWithNudge = async (
  assertion: () => Promise<boolean>,
  repoPath: string,
  timeoutMs = 10_000,
  label?: string
): Promise<void> => {
  const { utimesSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')

  const gitDir = join(repoPath, '.git')
  const start = Date.now()
  let nudgeCount = 0
  while (Date.now() - start < timeoutMs) {
    if (await assertion()) {
      return
    }
    // Nudge every 500ms to force FSEvents batch flushes
    nudgeCount += 1
    if (nudgeCount % 5 === 0) {
      try {
        const now = new Date()
        utimesSync(gitDir, now, now)
        writeFileSync(join(gitDir, `.watcher-nudge-${Date.now()}`), '')
      } catch {
        // Ignore — the git dir may have been cleaned up
      }
    }
    await delay(100)
  }
  const suffix = label !== undefined ? `: ${label}` : ''
  throw new Error(`Timed out waiting for condition${suffix}`)
}
