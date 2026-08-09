import type {
  AgentStatus,
  AgentStatusReport,
  AgentStatusSnapshot,
} from '@laborer/shared/rpc'

const DEFAULT_DOWNWARD_CONFIRMATIONS = 3
const DEFAULT_STALE_AFTER_MS = 10_000

interface AgentProcess {
  readonly pid: number
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
  readonly processId: number | null
  readonly status: AgentStatus
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

  constructor(options: StatusEngineOptions = {}) {
    this.#downwardConfirmations =
      options.downwardConfirmations ?? DEFAULT_DOWNWARD_CONFIRMATIONS
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  get current(): AgentStatusSnapshot | null {
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
        const authorityPid = this.#hookAuthority.processId
        if (authorityPid === null) {
          this.#hookAuthority = {
            ...this.#hookAuthority,
            processId: processIds.values().next().value ?? null,
          }
        } else if (!processIds.has(authorityPid)) {
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
      return this.#transition('working', 'ps', sample.sampledAt)
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
      processId: this.#lastAgentProcessIds.values().next().value ?? null,
      status: report.status,
    }
    this.#downwardSamples = 0
    return this.#transition(report.status, 'hook', reportedAt)
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
      return this.#snapshot
    }
    this.#snapshot = { status, source, changedAt, stale: false }
    return this.#snapshot
  }
}

export {
  type AgentProcess,
  type ProcessSample,
  type StatusEngineOptions,
  TerminalStatusEngine,
}
