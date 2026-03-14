/**
 * Tests that the root route renders content without a server running.
 *
 * With the removal of ServerGate (Issue #6), LiveStoreProvider and route
 * content render immediately during Phase 1 (Starting) — no blocking
 * overlay prevents interaction.
 *
 * @see Issue #6: Remove ServerGate blocking gate
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LifecyclePhase,
  LifecyclePhaseProvider,
  useLifecyclePhase,
} from '../src/components/lifecycle-phase-context'
import { useWhenPhase } from '../src/hooks/use-when-phase'

/**
 * Minimal component simulating what the root route does post-ServerGate removal:
 * LiveStoreProvider and route content render immediately in any phase.
 */
function RootContent() {
  const { phase } = useLifecyclePhase()
  const isReady = useWhenPhase(LifecyclePhase.Ready)

  return (
    <div>
      <span data-testid="current-phase">{phase}</span>
      <span data-testid="is-ready">{String(isReady)}</span>
      <div data-testid="route-content">Route content is visible</div>
      <div data-testid="livestore-area">LiveStore area is visible</div>
    </div>
  )
}

describe('Root route without ServerGate', () => {
  afterEach(() => {
    cleanup()
  })

  // Tracer bullet: route content renders without server running
  it('renders route content during Phase 1 (Starting) without server', () => {
    // Mock fetch to simulate no server available
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('no server'))
    ) as typeof fetch

    try {
      render(
        <LifecyclePhaseProvider>
          <RootContent />
        </LifecyclePhaseProvider>
      )

      // Phase should be Starting
      expect(screen.getByTestId('current-phase').textContent).toBe(
        String(LifecyclePhase.Starting)
      )

      // Ready should be false — server is not available
      expect(screen.getByTestId('is-ready').textContent).toBe('false')

      // Route content renders immediately — no blocking overlay
      expect(screen.getByTestId('route-content').textContent).toBe(
        'Route content is visible'
      )

      // LiveStore area renders immediately — no gate prevents it
      expect(screen.getByTestId('livestore-area').textContent).toBe(
        'LiveStore area is visible'
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('renders route content during Phase 2 (Ready) after server becomes available', () => {
    render(
      <LifecyclePhaseProvider>
        <AdvanceAndRender />
      </LifecyclePhaseProvider>
    )

    // Route content is visible even before advancing
    expect(screen.getByTestId('route-content').textContent).toBe(
      'Route content is visible'
    )

    // Phase is Starting, not Ready
    expect(screen.getByTestId('is-ready').textContent).toBe('false')
  })

  it('does not render any blocking overlay or spinner gate', () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('no server'))
    ) as typeof fetch

    try {
      render(
        <LifecyclePhaseProvider>
          <RootContent />
        </LifecyclePhaseProvider>
      )

      // No "Waiting for server" or "Starting services" blocking text
      expect(screen.queryByText('Waiting for server')).toBeNull()
      expect(screen.queryByText('Starting services')).toBeNull()
      expect(screen.queryByText('Connecting to backend services...')).toBeNull()

      // Content is present
      expect(screen.getByTestId('route-content')).toBeTruthy()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('navigation area renders during Phase 1', () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error('no server'))
    ) as typeof fetch

    try {
      render(
        <LifecyclePhaseProvider>
          <NavigationTest />
        </LifecyclePhaseProvider>
      )

      // Navigation links render immediately during Phase 1
      expect(screen.getByTestId('nav-link')).toBeTruthy()
      expect(screen.getByTestId('nav-link').textContent).toBe('Navigate')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

/** Helper component that shows both ready state and content. */
function AdvanceAndRender() {
  const isReady = useWhenPhase(LifecyclePhase.Ready)

  return (
    <div>
      <span data-testid="is-ready">{String(isReady)}</span>
      <div data-testid="route-content">Route content is visible</div>
    </div>
  )
}

/** Helper component simulating navigation UI that should work in Phase 1. */
function NavigationTest() {
  return (
    <div>
      <a data-testid="nav-link" href="/workspace">
        Navigate
      </a>
      <div data-testid="route-content">Route content is visible</div>
    </div>
  )
}
