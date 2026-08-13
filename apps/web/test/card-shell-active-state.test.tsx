/**
 * Tests for how the shared card shell draws "you are here".
 *
 * The card has two cues competing for one small rectangle: which card the
 * operator is currently in, and which card wants them. They are split by
 * channel — the active card fills its surface, an agent status colours the
 * edge — so a sidebar full of cards never shouts about the one workspace
 * the operator is already looking at.
 *
 * @see apps/web/src/components/card-shell.tsx
 * @see apps/web/src/lib/agent-status-presentation.ts
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CardShell } from '../src/components/card-shell'
import { getAgentStatusSurface } from '../src/lib/agent-status-presentation'

const WHITESPACE = /\s+/

const cardClasses = (): string =>
  screen.getByTestId('card').className.split(WHITESPACE).join(' ')

describe('card shell active state', () => {
  afterEach(() => {
    cleanup()
  })

  it('fills the active card instead of outlining it', () => {
    render(<CardShell data-testid="card" selected title="master" />)

    const classes = cardClasses()

    expect(classes).toContain('bg-accent/50')
    // A bright, doubled edge on the card the operator is already looking at
    // is noise: it competes with the one cue worth interrupting for.
    expect(classes).not.toContain('ring-2')
    expect(classes).not.toContain('ring-primary')
  })

  it('leaves a resting card entirely quiet', () => {
    render(<CardShell data-testid="card" title="master" />)

    const classes = cardClasses()

    expect(classes).not.toContain('bg-accent/50')
    expect(classes).toContain('ring-foreground/10')
  })

  it('lets the agent accent keep the edge of the active card', () => {
    // Being in a workspace does not stop it asking for you: the fill says
    // "here", the ring says "now", and both survive on the same card.
    render(
      <CardShell
        className={getAgentStatusSurface('needs_input').cardClassName}
        data-testid="card"
        selected
        title="matching-cards"
      />
    )

    const classes = cardClasses()

    expect(classes).toContain('bg-accent/50')
    expect(classes).toContain('ring-2')
    expect(classes).toContain('ring-amber-400/70')
    // The resting hairline and the active edge both lose to the accent, so
    // the blocked agent draws one edge rather than fighting for it.
    expect(classes).not.toContain('ring-1')
    expect(classes).not.toContain('ring-foreground/25')
  })
})
