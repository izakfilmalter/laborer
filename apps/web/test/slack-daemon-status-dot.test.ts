/**
 * Regression test for the Slack daemon status dot's motion budget.
 *
 * Motion is reserved for states that are unsettled or wrong. A running daemon
 * is the steady state, so its dot holds still: a permanent ping keeps the
 * compositor repainting for the whole session and says nothing the solid green
 * dot does not already say.
 *
 * @see apps/web/src/components/slack-daemon-status-button.tsx
 */

import { describe, expect, it } from 'vitest'
import { tonePulses } from '../src/components/slack-daemon-status-button'

describe('Slack daemon status dot motion', () => {
  it('holds still in the settled states', () => {
    expect(tonePulses('running')).toBe(false)
    expect(tonePulses('stopped')).toBe(false)
  })

  it('animates while unsettled or failed', () => {
    expect(tonePulses('pending')).toBe(true)
    expect(tonePulses('error')).toBe(true)
  })
})
