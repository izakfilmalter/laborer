import type {
  AgentStatus,
  AgentStatusReport,
  AgentStatusSnapshot,
} from '@laborer/shared/rpc'

const DEFAULT_DOWNWARD_CONFIRMATIONS = 3
const DEFAULT_STALE_AFTER_MS = 10_000

/**
 * `ps` raw names (`ps -o comm=`) of agents Laborer ships a status hook for.
 *
 * For these agents the hook reports the lifecycle and process inspection is
 * only corroborating evidence, so a running process on its own says nothing
 * about whether the agent is busy — an OpenCode TUI parked on its session
 * picker looks identical to one mid-turn. Agents absent from this set have no
 * hook, so process presence remains the only available signal.
 *
 * @see packages/server/src/services/opencode-status-plugin.ts
 * @see packages/server/src/services/claude-status-hooks.ts
 */
const HOOK_BACKED_AGENTS: ReadonlySet<string> = new Set([
  'claude',
  'opencode',
  'opencode2',
])

interface AgentProcess {
  readonly pid: number
  /** Raw `ps` process name, used to decide whether a hook governs this agent. */
  readonly rawName: string
}

interface ProcessSample {
  readonly agentProcesses: readonly AgentProcess[]
  readonly hasNonAgentProcess?: boolean
  readonly sampledAt: number
}

interface StatusEngineOptions {
  readonly downwardConfirmations?: number
  readonly staleAfterMs?: number
}

interface HookAuthority {
  /**
   * Agent PIDs observed when the report landed, identifying the process
   * generation the report describes. Empty when no successful sample had
   * been taken yet; the next sample adopts its generation.
   */
  readonly processIds: ReadonlySet<number>
  readonly status: AgentStatus
}

/**
 * Whether two agent PID sets describe the same process generation.
 *
 * Agents fork helpers and daemons, so the PID set churns within a single
 * run. Any overlap means the generation survived; a wholly disjoint set
 * means the agent was replaced and its hook state no longer applies.
 */
const sharesProcessGeneration = (
  authorityPids: ReadonlySet<number>,
  processIds: ReadonlySet<number>
): boolean => {
  for (const pid of authorityPids) {
    if (processIds.has(pid)) {
      return true
    }
  }
  return false
}

/**
 * Arbitrates process inspection and hook evidence for one terminal.
 * Detection failures are observations about confidence, never lifecycle
 * evidence, and therefore cannot produce a status transition.
 */
class TerminalStatusEngine {
  readonly #downwardConfirmations: number
  readonly #staleAfterMs: number
  #snapshot: AgentStatusSnapshot | null = null
  #lastAgentProcessIds = new Set<number>()
  #hookAuthority: HookAuthority | null = null
  #lastHookSequence = -1
  #downwardSamples = 0
  #firstFailureAt: number | null = null
  #hasSuccessfulSample = false
  #observed = false

  constructor(options: StatusEngineOptions = {}) {
    this.#downwardConfirmations =
      options.downwardConfirmations ?? DEFAULT_DOWNWARD_CONFIRMATIONS
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  get current(): AgentStatusSnapshot | null {
    return this.#snapshot
  }

  /** Update focused visibility and acknowledge an unseen completion. */
  setObserved(observed: boolean): AgentStatusSnapshot | null {
    this.#observed = observed
    if (observed && this.#snapshot?.seen === false) {
      this.#snapshot = { ...this.#snapshot, seen: true }
    }
    return this.#snapshot
  }

  sample(sample: ProcessSample): AgentStatusSnapshot | null {
    this.#recoverDetection()
    this.#hasSuccessfulSample = true
    const processIds = new Set(sample.agentProcesses.map(({ pid }) => pid))
    this.#lastAgentProcessIds = processIds

    if (processIds.size > 0) {
      this.#downwardSamples = 0
      if (this.#hookAuthority !== null) {
        if (this.#hookAuthority.processIds.size === 0) {
          this.#hookAuthority = {
            ...this.#hookAuthority,
            processIds,
          }
        } else if (
          !sharesProcessGeneration(this.#hookAuthority.processIds, processIds)
        ) {
          this.#hookAuthority = null
        }
      }

      if (this.#hookAuthority !== null) {
        return this.#transition(
          this.#hookAuthority.status,
          'hook',
          sample.sampledAt
        )
      }
      return this.#transition(
        this.#statusFromProcesses(sample.agentProcesses),
        'ps',
        sample.sampledAt
      )
    }

    if (this.#snapshot === null) {
      this.#hookAuthority = null
      this.#downwardSamples = 0
      return null
    }

    this.#downwardSamples += 1
    if (this.#downwardSamples < this.#downwardConfirmations) {
      return this.#snapshot
    }

    this.#hookAuthority = null
    if (sample.hasNonAgentProcess === true) {
      this.#snapshot = null
      return null
    }
    return this.#transition('idle', 'ps', sample.sampledAt)
  }

  unavailable(observedAt: number): AgentStatusSnapshot | null {
    this.#downwardSamples = 0
    this.#firstFailureAt ??= observedAt
    if (
      this.#snapshot !== null &&
      !this.#snapshot.stale &&
      observedAt - this.#firstFailureAt >= this.#staleAfterMs
    ) {
      this.#snapshot = { ...this.#snapshot, stale: true }
    }
    return this.#snapshot
  }

  /** Publish completion before an explicit PTY/process exit clears status. */
  processExited(observedAt: number): AgentStatusSnapshot | null {
    this.#lastAgentProcessIds.clear()
    this.#hookAuthority = null
    this.#downwardSamples = 0
    return this.#snapshot === null
      ? null
      : this.#transition('idle', 'ps', observedAt)
  }

  report(
    report: AgentStatusReport,
    reportedAt: number
  ): AgentStatusSnapshot | null {
    if (report.sequence <= this.#lastHookSequence) {
      return this.#snapshot
    }
    this.#lastHookSequence = report.sequence

    // A report received after process inspection has confirmed that no agent
    // exists is late evidence from an exited generation.
    if (this.#hasSuccessfulSample && this.#lastAgentProcessIds.size === 0) {
      return this.#snapshot
    }

    this.#hookAuthority = {
      processIds: new Set(this.#lastAgentProcessIds),
      status: report.status,
    }
    this.#downwardSamples = 0
    return this.#transition(report.status, 'hook', reportedAt)
  }

  /**
   * Status implied by process inspection alone, with no hook authority.
   *
   * Process presence proves an agent is running, never that it is busy. When
   * every running agent is hook-backed, the absent hook evidence is the whole
   * answer and the honest status is `unknown` — claiming `working` pins an
   * idle agent to a busy badge for as long as it stays open. A non-hooked
   * agent has no better signal available, so presence still implies `working`.
   */
  #statusFromProcesses(agentProcesses: readonly AgentProcess[]): AgentStatus {
    return agentProcesses.every(({ rawName }) =>
      HOOK_BACKED_AGENTS.has(rawName)
    )
      ? 'unknown'
      : 'working'
  }

  #recoverDetection(): void {
    this.#firstFailureAt = null
    if (this.#snapshot?.stale === true) {
      this.#snapshot = { ...this.#snapshot, stale: false }
    }
  }

  #transition(
    status: AgentStatus,
    source: AgentStatusSnapshot['source'],
    changedAt: number
  ): AgentStatusSnapshot {
    if (this.#snapshot?.status === status && this.#snapshot.source === source) {
      if (status !== 'idle' && !this.#snapshot.seen) {
        this.#snapshot = { ...this.#snapshot, seen: true }
      }
      return this.#snapshot
    }
    const completed =
      status === 'idle' &&
      this.#snapshot !== null &&
      this.#snapshot.status !== 'idle'
    const seen =
      status !== 'idle' ||
      (completed
        ? this.#observed
        : (this.#snapshot?.seen ?? true) || this.#observed)
    this.#snapshot = { status, source, changedAt, stale: false, seen }
    return this.#snapshot
  }
}

export {
  type AgentProcess,
  type ProcessSample,
  type StatusEngineOptions,
  TerminalStatusEngine,
}
