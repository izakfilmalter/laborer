/**
 * The description editor's contract with the card that stores its text.
 *
 * A brief is stored as markdown and handed to an agent as markdown, so what
 * matters here is the round trip, not the typing: what the editor shows for a
 * given brief, and what it reports back for the caller to save. Slate edits
 * through `beforeinput`, which jsdom never dispatches, so keystrokes cannot be
 * exercised in this environment — the dialog's own suite stands the editor in
 * for that reason, which makes the round trip covered here the seam that keeps
 * the two honest.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DescriptionEditor } from '@/components/editor/description-editor'

afterEach(cleanup)

const BRIEF = [
  '## Handoff',
  '',
  'Use the `slack-feature-to-pr` skill.',
  '',
  '- default schema/backfill',
  '- serialized first-default assignment',
  '',
  '1. First',
  '2. Second',
  '',
  '```ts',
  'const answer = 42',
  '```',
  '',
  '> Do not merge #891 wholesale.',
].join('\n')

describe('DescriptionEditor', () => {
  it('shows a stored brief as the structure its markdown describes', () => {
    render(<DescriptionEditor ariaLabel="Description" value={BRIEF} />)
    const editable = screen.getByLabelText('Description')

    expect(editable.querySelector('h2')?.textContent).toBe('Handoff')
    expect(editable.querySelector('ul')?.textContent).toContain(
      'default schema/backfill'
    )
    expect(editable.querySelector('ol')?.textContent).toContain('First')
    expect(editable.querySelector('pre')?.textContent).toContain(
      'const answer = 42'
    )
    expect(editable.querySelector('blockquote')?.textContent).toContain(
      'Do not merge'
    )
    // Inline code has to survive too: a brief is mostly paths and commands.
    expect(editable.querySelector('code')?.textContent).toContain(
      'slack-feature-to-pr'
    )
  })

  it('reports the markdown it would write, so an unedited card is not dirty', () => {
    const onNormalize = vi.fn()
    render(
      <DescriptionEditor
        ariaLabel="Description"
        onNormalize={onNormalize}
        value={BRIEF}
      />
    )

    expect(onNormalize).toHaveBeenCalledTimes(1)
    const normalized = onNormalize.mock.calls[0]?.[0] as string

    // Every block of the brief comes back. The text may be reformatted — that
    // is why the caller is given this string rather than trusting the stored
    // one — but nothing may be dropped.
    expect(normalized).toContain('## Handoff')
    // Bullets keep the `-` briefs are already written with, so opening a card
    // and saving one edit does not rewrite every list in it.
    expect(normalized).toContain('- default schema/backfill')
    expect(normalized).toContain('`slack-feature-to-pr`')
    expect(normalized).toContain('default schema/backfill')
    expect(normalized).toContain('const answer = 42')
    expect(normalized).toContain('Do not merge #891 wholesale.')

    // And it is stable: normalizing the normalized text changes nothing, so a
    // card cannot drift a little further from its stored form on every open.
    const second = vi.fn()
    render(
      <DescriptionEditor
        ariaLabel="Second"
        onNormalize={second}
        value={normalized}
      />
    )
    expect(second.mock.calls[0]?.[0]).toBe(normalized)
  })

  it('starts empty for a card with no brief yet', () => {
    const onNormalize = vi.fn()
    render(
      <DescriptionEditor
        ariaLabel="Description"
        onNormalize={onNormalize}
        placeholder="What should the agent know or do?"
        value=""
      />
    )

    // Slate fills an empty leaf with a zero-width no-break space so the caret
    // has somewhere to sit; nothing else may be showing.
    expect(
      screen.getByLabelText('Description').textContent?.replaceAll('\uFEFF', '')
    ).toBe('')
    // Exactly the empty string, not the zero-width characters Slate seeds an
    // empty document with: the caller stores this verbatim and hands it to an
    // agent as its prompt, and treats a non-empty string as a brief worth
    // saving.
    expect(onNormalize.mock.calls[0]?.[0]).toBe('')
  })
})
