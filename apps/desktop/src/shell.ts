import { execFileSync } from 'node:child_process'

/**
 * Sentinel markers used to delimit the PATH value in shell output.
 * These allow reliable extraction even when the shell prints startup
 * noise (fish greeting, motd, etc.) around the actual PATH value.
 */
const PATH_CAPTURE_START = '__LABORER_PATH_START__'
const PATH_CAPTURE_END = '__LABORER_PATH_END__'

/**
 * Shell command that prints PATH between sentinel markers.
 * Uses `printenv PATH` (POSIX-portable) rather than `echo $PATH`
 * to avoid shell-specific quoting issues.
 */
const PATH_CAPTURE_COMMAND = [
  `printf '%s\n' '${PATH_CAPTURE_START}'`,
  'printenv PATH',
  `printf '%s\n' '${PATH_CAPTURE_END}'`,
].join('; ')

type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: { encoding: 'utf8'; timeout: number }
) => string

/**
 * Extract the PATH value from shell output that contains our sentinel markers.
 * Returns null if the markers are not found or the value between them is empty.
 */
export function extractPathFromShellOutput(output: string): string | null {
  const startIndex = output.indexOf(PATH_CAPTURE_START)
  if (startIndex === -1) {
    return null
  }

  const valueStartIndex = startIndex + PATH_CAPTURE_START.length
  const endIndex = output.indexOf(PATH_CAPTURE_END, valueStartIndex)
  if (endIndex === -1) {
    return null
  }

  const pathValue = output.slice(valueStartIndex, endIndex).trim()
  return pathValue.length > 0 ? pathValue : null
}

/**
 * Launch a login shell and capture its PATH.
 *
 * Runs the shell with `-ilc` (interactive + login + command) flags to
 * ensure all shell profile files (.bashrc, .zshrc, config.fish, etc.)
 * are sourced. This captures PATH additions from homebrew, nvm, pyenv,
 * cargo, and other tools.
 *
 * The `execFile` parameter allows injecting a mock for testing.
 */
export function readPathFromLoginShell(
  shell: string,
  execFile: ExecFileSyncLike = execFileSync
): string | undefined {
  const output = execFile(shell, ['-ilc', PATH_CAPTURE_COMMAND], {
    encoding: 'utf8',
    timeout: 5000,
  })
  return extractPathFromShellOutput(output) ?? undefined
}
