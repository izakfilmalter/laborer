import { readPathFromLoginShell } from './shell.js'

/**
 * Fix the PATH environment variable on macOS.
 *
 * When launched from launchd (Finder, Dock, Spotlight), Electron inherits
 * a minimal PATH from the system — typically just `/usr/bin:/bin:/usr/sbin:/sbin`.
 * This means child processes can't find tools installed via homebrew, nvm,
 * pyenv, cargo, etc.
 *
 * This function launches the user's login shell to capture the full PATH
 * with all profile additions, then sets `process.env.PATH` to the result.
 * Must be called synchronously before spawning any child processes.
 */
export function fixPath(): void {
  if (process.platform !== 'darwin') {
    return
  }

  try {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const result = readPathFromLoginShell(shell)
    if (result) {
      process.env.PATH = result
    }
  } catch {
    // Keep inherited PATH if shell lookup fails.
    // This is intentionally silent — a broken shell config shouldn't
    // prevent the app from launching.
  }
}
