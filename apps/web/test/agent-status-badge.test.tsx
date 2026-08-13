/**
 * Render tests for the shared Agent status badge.
 *
 * These cover the parts of the badge that only exist in the DOM: the state
 * is announced once rather than twice, the dot is decorative, and stale
 * detection is visible as a hollow, still dot rather than colour alone.
 *
 * @see apps/web/src/components/agent-status-badge.tsx
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentStatusBadge,
  AggregateAgentStatusBadge,
} from '../src/components/agent-status-badge'
import type { AgentStatusSnapshot } from '../src/hooks/use-terminal-list'

afterEach(cleanup)

const snapshot = (
  overrides: Partial<AgentStatusSnapshot> = {}
): AgentStatusSnapshot => ({
  status: 'needs_input',
  source: 'ps',
  changedAt: 0,
  stale: false,
  seen: true,
  ...overrides,
})

/** The dot is the last-rendered span inside the dot wrapper. */
function dotElement(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector('[aria-hidden="true"].relative')
  const dot = wrapper?.lastElementChild

  if (!(dot instanceof HTMLElement)) {
    throw new Error('status dot not found')
  }

  return dot
}

describe('AgentStatusBadge', () => {
  it('announces the state and its provenance exactly once', () => {
    render(<AgentStatusBadge snapshot={snapshot()} />)

    const badge = screen.getByText('needs input').parentElement
    const description = badge?.textContent ?? ''

    // The visible label is hidden from assistive tech, so the state name
    // appears once in the announced sentence rather than twice.
    expect(screen.getByText('needs input').getAttribute('aria-hidden')).toBe(
      'true'
    )
    expect(description).toContain('waiting on you')
    expect(description).toContain('process inspection')
  })

  it('hides the decorative dot from assistive tech', () => {
    const { container } = render(<AgentStatusBadge snapshot={snapshot()} />)

    expect(
      container.querySelector('[aria-hidden="true"].relative')
    ).not.toBeNull()
  })

  it('renders a filled, animated dot for fresh detection', () => {
    const { container } = render(<AgentStatusBadge snapshot={snapshot()} />)
    const dot = dotElement(container)

    expect(dot.className).toContain('bg-amber-400')
    expect(dot.className).not.toContain('border-amber-400')
  })

  it('hollows the dot and stops the motion when detection is stale', () => {
    const { container } = render(
      <AgentStatusBadge snapshot={snapshot({ stale: true })} />
    )
    const dot = dotElement(container)

    expect(dot.className).toContain('border-amber-400')
    expect(dot.className).not.toContain('bg-amber-400')
    expect(container.innerHTML).not.toContain('animate-ping')
    expect(
      screen.getByText('needs input').parentElement?.textContent
    ).toContain('out of date')
  })

  it('renders unseen idle as a distinct done treatment', () => {
    const { container } = render(
      <AgentStatusBadge snapshot={snapshot({ status: 'idle', seen: false })} />
    )

    const badge = screen.getByText('done').parentElement

    expect(badge?.getAttribute('data-agent-status')).toBe('done')
    expect(badge?.className).toContain('violet')
    expect(container.innerHTML).not.toContain('bg-amber-400')
  })

  it('marks done with a check rather than a lifecycle dot', () => {
    const { container } = render(
      <AgentStatusBadge snapshot={snapshot({ status: 'idle', seen: false })} />
    )

    // Shape, not hue: the check survives colour-blindness and tells
    // "review this result" apart from "act on this now".
    expect(
      container.querySelector('[data-testid="agent-status-check"]')
    ).not.toBeNull()
    expect(container.querySelector('[aria-hidden="true"].relative')).toBeNull()
  })

  it('keeps the done check still and readable when detection is stale', () => {
    const { container } = render(
      <AgentStatusBadge
        snapshot={snapshot({ status: 'idle', seen: false, stale: true })}
      />
    )

    const badge = screen.getByText('done').parentElement

    expect(
      container.querySelector('[data-testid="agent-status-check"]')
    ).not.toBeNull()
    expect(badge?.className).toContain('border-dashed')
    expect(container.innerHTML).not.toContain('animate-ping')
    expect(badge?.textContent).toContain('out of date')
  })
})

describe('AggregateAgentStatusBadge', () => {
  it('reads with the same vocabulary as the per-terminal badge', () => {
    render(<AggregateAgentStatusBadge status="working" />)

    const label = screen.getByText('working')

    expect(label.getAttribute('aria-hidden')).toBe('true')
    expect(label.parentElement?.textContent).toContain('The agent is working.')
  })
})
