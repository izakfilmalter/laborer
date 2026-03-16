/**
 * Pure functions for deriving per-service sidecar status from a stream
 * of SidecarStatusEvent values.
 *
 * @see packages/shared/src/desktop-bridge.ts — SidecarStatusEvent type
 */

import type {
  SidecarName,
  SidecarStatusEvent,
} from '@laborer/shared/desktop-bridge'

/** All sidecar service names in display order. */
const ALL_SIDECAR_NAMES: readonly SidecarName[] = [
  'server',
  'terminal',
  'file-watcher',
  'mcp',
] as const

/** Possible states for a single service in the UI. */
type ServiceState =
  | { readonly state: 'unknown' }
  | { readonly state: 'starting' }
  | { readonly state: 'healthy' }
  | { readonly state: 'crashed'; readonly error: string }
  | { readonly state: 'restarting'; readonly delayMs: number }

/** Map of every sidecar service to its current UI state. */
type SidecarStatuses = Record<SidecarName, ServiceState>

/**
 * Reduce a sequence of sidecar status events into the current state
 * for each service. The last event for each service wins.
 */
function deriveSidecarStatuses(
  events: readonly SidecarStatusEvent[]
): SidecarStatuses {
  const statuses: Record<string, ServiceState> = {}
  for (const name of ALL_SIDECAR_NAMES) {
    statuses[name] = { state: 'unknown' }
  }

  for (const event of events) {
    switch (event.state) {
      case 'starting': {
        statuses[event.name] = { state: 'starting' }
        break
      }
      case 'healthy': {
        statuses[event.name] = { state: 'healthy' }
        break
      }
      case 'crashed': {
        statuses[event.name] = { state: 'crashed', error: event.error }
        break
      }
      case 'restarting': {
        statuses[event.name] = {
          state: 'restarting',
          delayMs: event.delayMs,
        }
        break
      }
      default: {
        // Exhaustive — future states are ignored until handled
        break
      }
    }
  }

  return statuses as SidecarStatuses
}

/** Human-readable display names for sidecar services. */
const DISPLAY_NAMES: Record<SidecarName, string> = {
  server: 'Server',
  terminal: 'Terminal',
  'file-watcher': 'File Watcher',
  mcp: 'MCP',
}

/** Get a human-readable display name for a sidecar service. */
function getDisplayName(name: SidecarName): string {
  return DISPLAY_NAMES[name]
}

/** Semantic color for a service state, used to style status indicators. */
type StatusColor = 'gray' | 'green' | 'red' | 'yellow'

/** Map a service state to a semantic color. */
function getStatusColor(state: ServiceState): StatusColor {
  switch (state.state) {
    case 'healthy': {
      return 'green'
    }
    case 'starting':
    case 'restarting': {
      return 'yellow'
    }
    case 'crashed': {
      return 'red'
    }
    case 'unknown': {
      return 'gray'
    }
    default: {
      return 'gray'
    }
  }
}

/** Get a human-readable label for a service state. */
function getStatusLabel(state: ServiceState): string {
  switch (state.state) {
    case 'unknown': {
      return 'Unknown'
    }
    case 'starting': {
      return 'Starting'
    }
    case 'healthy': {
      return 'Healthy'
    }
    case 'crashed': {
      return `Crashed: ${state.error}`
    }
    case 'restarting': {
      return 'Restarting'
    }
    default: {
      return 'Unknown'
    }
  }
}

/**
 * The core services that must be healthy for the app to function.
 * MCP is excluded because it starts independently and is not required
 * for the main UI to work.
 */
const CORE_SIDECAR_NAMES: readonly SidecarName[] = [
  'server',
  'terminal',
  'file-watcher',
] as const

/**
 * Check whether all core services (server, terminal, file-watcher) are healthy.
 * Returns false if any core service is not in the `healthy` state.
 */
function areCoreServicesHealthy(statuses: SidecarStatuses): boolean {
  return CORE_SIDECAR_NAMES.every((name) => statuses[name].state === 'healthy')
}

/**
 * Check whether any core service has crashed (not starting/restarting, but
 * actually in the `crashed` state). Used to show error UI in the server gate.
 */
function hasAnyCoreServiceCrashed(statuses: SidecarStatuses): boolean {
  return CORE_SIDECAR_NAMES.some((name) => statuses[name].state === 'crashed')
}

export {
  ALL_SIDECAR_NAMES,
  areCoreServicesHealthy,
  CORE_SIDECAR_NAMES,
  deriveSidecarStatuses,
  getDisplayName,
  getStatusColor,
  getStatusLabel,
  hasAnyCoreServiceCrashed,
}
export type { ServiceState, SidecarStatuses, StatusColor }
