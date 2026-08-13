import {
  type ChildProcessWithoutNullStreams,
  execFile,
} from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const PROCESS_GROUP_POLL_MILLIS = 25
const PROCESS_COLUMNS_SEPARATOR = /\s+/
const execFilePromise = promisify(execFile)

export const processSupervisorProxyPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'process-supervisor-proxy.ts'
)

const leaderIsAlive = (child: ChildProcessWithoutNullStreams): boolean =>
  child.exitCode === null && child.signalCode === null

const signalProcessGroup = (
  processGroupId: number,
  signal: NodeJS.Signals
): boolean => {
  try {
    process.kill(-processGroupId, signal)
    return true
  } catch {
    return false
  }
}

const processGroupMembers = async (
  processGroupId: number,
  timeoutMillis: number
): Promise<readonly number[]> => {
  const { stdout } = await execFilePromise(
    '/bin/ps',
    ['-axo', 'pid=,pgid=,stat='],
    {
      maxBuffer: 1024 * 1024,
      timeout: Math.max(1, timeoutMillis),
    }
  )
  return stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pidSource, groupSource, status] = line
        .trim()
        .split(PROCESS_COLUMNS_SEPARATOR, 3)
      const pid = Number(pidSource)
      const group = Number(groupSource)
      return group === processGroupId &&
        Number.isSafeInteger(pid) &&
        !status?.startsWith('Z')
        ? [pid]
        : []
    })
}

const waitForLeaderExit = (
  child: ChildProcessWithoutNullStreams,
  timeoutMillis: number
): Promise<boolean> => {
  if (!leaderIsAlive(child)) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(false)
    }, timeoutMillis)
    const onExit = (): void => {
      clearTimeout(timeout)
      resolveExit(true)
    }
    child.once('exit', onExit)
    if (!leaderIsAlive(child)) {
      child.off('exit', onExit)
      clearTimeout(timeout)
      resolveExit(true)
    }
  })
}

const terminateDirectChild = async (
  child: ChildProcessWithoutNullStreams,
  graceMillis: number
): Promise<ProcessTerminationOutcome> => {
  if (!leaderIsAlive(child)) {
    return 'already_exited'
  }
  child.kill('SIGTERM')
  if (await waitForLeaderExit(child, graceMillis)) {
    return 'term'
  }
  if (leaderIsAlive(child)) {
    child.kill('SIGKILL')
  }
  if (!(await waitForLeaderExit(child, graceMillis))) {
    throw new Error('supervised child did not settle after SIGKILL')
  }
  return 'kill'
}

export type ProcessTerminationOutcome = 'already_exited' | 'kill' | 'term'

export interface ProcessSupervisorTestHooks {
  readonly processGroupMembers?: (
    processGroupId: number,
    timeoutMillis: number
  ) => Promise<readonly number[]>
  readonly signalProcessGroup?: (
    processGroupId: number,
    signal: NodeJS.Signals
  ) => boolean
}

const signalOwnedGroup = (
  child: ChildProcessWithoutNullStreams,
  processGroupId: number,
  signal: NodeJS.Signals,
  signalGroup: (processGroupId: number, signal: NodeJS.Signals) => boolean
): void => {
  if (!leaderIsAlive(child)) {
    return
  }
  if (!signalGroup(processGroupId, signal) && leaderIsAlive(child)) {
    child.kill(signal)
  }
}

/**
 * Terminates a detached process group through its stable proxy leader. Group
 * signals are forbidden once the owned leader exits, avoiding numeric-PGID
 * reuse races. Platforms without detached groups use bounded direct cleanup.
 */
export const terminateSupervisedProcess = async (
  child: ChildProcessWithoutNullStreams,
  graceMillis: number,
  ownsProcessGroup = true,
  testHooks: ProcessSupervisorTestHooks = {}
): Promise<ProcessTerminationOutcome> => {
  const processGroupId = child.pid
  // A failed spawn has no process to own and emits `error` without an `exit`.
  // Treating that shape as a live direct child would manufacture cleanup
  // uncertainty while waiting for an exit event that can never arrive.
  if (processGroupId === undefined) {
    return 'already_exited'
  }
  if (!ownsProcessGroup) {
    return await terminateDirectChild(child, graceMillis)
  }
  if (!leaderIsAlive(child)) {
    return 'already_exited'
  }

  const signalGroup = testHooks.signalProcessGroup ?? signalProcessGroup
  const groupMembers = testHooks.processGroupMembers ?? processGroupMembers
  signalOwnedGroup(child, processGroupId, 'SIGTERM', signalGroup)
  const deadline = Date.now() + graceMillis
  while (leaderIsAlive(child) && Date.now() < deadline) {
    try {
      const members = await groupMembers(
        processGroupId,
        Math.max(1, deadline - Date.now())
      )
      // An empty or incomplete inspection is not evidence that the sentinel is
      // the group's only live member. Fail closed to the bounded group KILL so
      // a successful but malformed `ps` response cannot strand descendants.
      if (members.length === 1 && members[0] === processGroupId) {
        child.kill('SIGKILL')
        if (!(await waitForLeaderExit(child, graceMillis))) {
          throw new Error('process supervisor did not settle after SIGKILL')
        }
        return 'kill'
      }
    } catch {
      // Keep the sentinel alive and fail over to the bounded group KILL below.
    }
    await new Promise<void>((resolveDelay) => {
      setTimeout(resolveDelay, PROCESS_GROUP_POLL_MILLIS)
    })
  }
  if (leaderIsAlive(child)) {
    signalOwnedGroup(child, processGroupId, 'SIGKILL', signalGroup)
    if (!(await waitForLeaderExit(child, graceMillis))) {
      throw new Error('process group did not settle after SIGKILL')
    }
    return 'kill'
  }
  return 'term'
}
