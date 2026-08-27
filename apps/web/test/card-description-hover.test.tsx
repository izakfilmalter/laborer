/**
 * Previewing what a card is for by hovering its title.
 *
 * The rule worth pinning down is when the preview exists at all: a card with
 * nothing to say must not open an empty popover every time the pointer crosses
 * its name on the way somewhere else.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CardDescriptionHover } from '@/components/card-description-hover'

const triggerIn = (container: HTMLElement) =>
  container.querySelector('[data-slot="hover-card-trigger"]')

describe('CardDescriptionHover', () => {
  it('makes the title hoverable when there is something to read', () => {
    const { container } = render(
      <CardDescriptionHover
        description="Rewrites the login redirect."
        heading="What fix-login is for"
      >
        <span>fix-login</span>
      </CardDescriptionHover>
    )

    expect(triggerIn(container)).not.toBeNull()
    expect(screen.getAllByText('fix-login').length).toBeGreaterThan(0)
  })

  it('leaves the title alone when the card has no description', () => {
    const { container } = render(
      <CardDescriptionHover description={null} heading="What fix-login is for">
        <span>fix-login</span>
      </CardDescriptionHover>
    )

    expect(triggerIn(container)).toBeNull()
    expect(container.textContent).toContain('fix-login')
  })

  it('treats a description of only whitespace as no description', () => {
    const { container } = render(
      <CardDescriptionHover
        description={'  \n  '}
        heading="What fix-login is for"
      >
        <span>fix-login</span>
      </CardDescriptionHover>
    )

    expect(triggerIn(container)).toBeNull()
  })
})
