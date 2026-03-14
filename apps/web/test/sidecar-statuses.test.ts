/**
 * Unit tests for deriveSidecarStatuses — a pure function that reduces
 * a sequence of SidecarStatusEvent values into a map of each service's
 * current status.
 *
 * @see apps/web/src/lib/sidecar-statuses.ts
 */

import type { SidecarStatusEvent } from '@laborer/shared/desktop-bridge'
import { describe, expect, it } from 'vitest'
import {
  ALL_SIDECAR_NAMES,
  areCoreServicesHealthy,
  deriveSidecarStatuses,
  getDisplayName,
  getStatusColor,
  getStatusLabel,
  hasAnyCoreServiceCrashed,
} from '../src/lib/sidecar-statuses'

describe('deriveSidecarStatuses', () => {
  it('returns all services as unknown when no events provided', () => {
    const result = deriveSidecarStatuses([])
    for (const name of ALL_SIDECAR_NAMES) {
      expect(result[name]).toEqual({ state: 'unknown' })
    }
  })

  it('marks a service as healthy when it receives a healthy event', () => {
    const events: readonly SidecarStatusEvent[] = [
      { state: 'healthy', name: 'server' },
    ]
    const result = deriveSidecarStatuses(events)
    expect(result.server).toEqual({ state: 'healthy' })
    expect(result.terminal).toEqual({ state: 'unknown' })
    expect(result['file-watcher']).toEqual({ state: 'unknown' })
    expect(result.mcp).toEqual({ state: 'unknown' })
  })

  it('tracks the starting state', () => {
    const events: readonly SidecarStatusEvent[] = [
      { state: 'starting', name: 'terminal' },
    ]
    const result = deriveSidecarStatuses(events)
    expect(result.terminal).toEqual({ state: 'starting' })
  })

  it('tracks crashed state with error message', () => {
    const events: readonly SidecarStatusEvent[] = [
      { state: 'crashed', name: 'file-watcher', error: 'ECONNREFUSED' },
    ]
    const result = deriveSidecarStatuses(events)
    expect(result['file-watcher']).toEqual({
      state: 'crashed',
      error: 'ECONNREFUSED',
    })
  })

  it('tracks restarting state with delay', () => {
    const events: readonly SidecarStatusEvent[] = [
      { state: 'restarting', name: 'mcp', delayMs: 2000 },
    ]
    const result = deriveSidecarStatuses(events)
    expect(result.mcp).toEqual({ state: 'restarting', delayMs: 2000 })
  })

  it('last event for a service wins when multiple events arrive', () => {
    const events: readonly SidecarStatusEvent[] = [
      { state: 'starting', name: 'server' },
      { state: 'healthy', name: 'server' },
      { state: 'crashed', name: 'server', error: 'OOM' },
    ]
    const result = deriveSidecarStatuses(events)
    expect(result.server).toEqual({ state: 'crashed', error: 'OOM' })
  })

  it('tracks multiple services independently', () => {
    const events: readonly SidecarStatusEvent[] = [
      { state: 'healthy', name: 'server' },
      { state: 'starting', name: 'terminal' },
      { state: 'crashed', name: 'file-watcher', error: 'timeout' },
      { state: 'restarting', name: 'mcp', delayMs: 5000 },
    ]
    const result = deriveSidecarStatuses(events)
    expect(result.server).toEqual({ state: 'healthy' })
    expect(result.terminal).toEqual({ state: 'starting' })
    expect(result['file-watcher']).toEqual({
      state: 'crashed',
      error: 'timeout',
    })
    expect(result.mcp).toEqual({ state: 'restarting', delayMs: 5000 })
  })
})

describe('getDisplayName', () => {
  it('returns human-readable names for each service', () => {
    expect(getDisplayName('server')).toBe('Server')
    expect(getDisplayName('terminal')).toBe('Terminal')
    expect(getDisplayName('file-watcher')).toBe('File Watcher')
    expect(getDisplayName('mcp')).toBe('MCP')
  })
})

describe('getStatusColor', () => {
  it('returns green for healthy', () => {
    expect(getStatusColor({ state: 'healthy' })).toBe('green')
  })

  it('returns yellow for starting and restarting', () => {
    expect(getStatusColor({ state: 'starting' })).toBe('yellow')
    expect(getStatusColor({ state: 'restarting', delayMs: 1000 })).toBe(
      'yellow'
    )
  })

  it('returns red for crashed', () => {
    expect(getStatusColor({ state: 'crashed', error: 'fail' })).toBe('red')
  })

  it('returns gray for unknown', () => {
    expect(getStatusColor({ state: 'unknown' })).toBe('gray')
  })
})

describe('getStatusLabel', () => {
  it('returns descriptive labels for each state', () => {
    expect(getStatusLabel({ state: 'unknown' })).toBe('Unknown')
    expect(getStatusLabel({ state: 'starting' })).toBe('Starting')
    expect(getStatusLabel({ state: 'healthy' })).toBe('Healthy')
    expect(getStatusLabel({ state: 'crashed', error: 'OOM' })).toBe(
      'Crashed: OOM'
    )
    expect(getStatusLabel({ state: 'restarting', delayMs: 3000 })).toBe(
      'Restarting'
    )
  })
})

describe('areCoreServicesHealthy', () => {
  it('returns false when all services are unknown', () => {
    const statuses = deriveSidecarStatuses([])
    expect(areCoreServicesHealthy(statuses)).toBe(false)
  })

  it('returns false when only some core services are healthy', () => {
    const statuses = deriveSidecarStatuses([
      { state: 'healthy', name: 'server' },
      { state: 'healthy', name: 'terminal' },
    ])
    expect(areCoreServicesHealthy(statuses)).toBe(false)
  })

  it('returns true when all core services are healthy (MCP irrelevant)', () => {
    const statuses = deriveSidecarStatuses([
      { state: 'healthy', name: 'server' },
      { state: 'healthy', name: 'terminal' },
      { state: 'healthy', name: 'file-watcher' },
    ])
    expect(areCoreServicesHealthy(statuses)).toBe(true)
  })

  it('returns true even when MCP is not healthy', () => {
    const statuses = deriveSidecarStatuses([
      { state: 'healthy', name: 'server' },
      { state: 'healthy', name: 'terminal' },
      { state: 'healthy', name: 'file-watcher' },
      { state: 'crashed', name: 'mcp', error: 'fail' },
    ])
    expect(areCoreServicesHealthy(statuses)).toBe(true)
  })

  it('returns false when a core service has crashed', () => {
    const statuses = deriveSidecarStatuses([
      { state: 'healthy', name: 'server' },
      { state: 'healthy', name: 'terminal' },
      { state: 'crashed', name: 'file-watcher', error: 'OOM' },
    ])
    expect(areCoreServicesHealthy(statuses)).toBe(false)
  })
})

describe('hasAnyCoreServiceCrashed', () => {
  it('returns false when no core services have crashed', () => {
    const statuses = deriveSidecarStatuses([])
    expect(hasAnyCoreServiceCrashed(statuses)).toBe(false)
  })

  it('returns true when a core service has crashed', () => {
    const statuses = deriveSidecarStatuses([
      { state: 'crashed', name: 'server', error: 'timeout' },
    ])
    expect(hasAnyCoreServiceCrashed(statuses)).toBe(true)
  })

  it('returns false when only MCP has crashed', () => {
    const statuses = deriveSidecarStatuses([
      { state: 'crashed', name: 'mcp', error: 'fail' },
    ])
    expect(hasAnyCoreServiceCrashed(statuses)).toBe(false)
  })

  it('returns true when file-watcher has crashed among healthy services', () => {
    const statuses = deriveSidecarStatuses([
      { state: 'healthy', name: 'server' },
      { state: 'healthy', name: 'terminal' },
      { state: 'crashed', name: 'file-watcher', error: 'ENOENT' },
    ])
    expect(hasAnyCoreServiceCrashed(statuses)).toBe(true)
  })
})
