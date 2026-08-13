import { readFileSync } from 'node:fs'

export const isProcessRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform !== 'linux') {
    return true
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    return commandEnd < 0 || stat.slice(commandEnd + 2, commandEnd + 3) !== 'Z'
  } catch {
    return false
  }
}
