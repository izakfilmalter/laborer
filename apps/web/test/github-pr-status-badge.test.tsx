import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'

const PR_URL = 'https://github.com/acme/widgets/pull/7'

const renderBadge = (
  unresolvedThreads: number | null,
  onOpenConversation?: () => void
) =>
  render(
    <GitHubPrStatusBadge
      onOpenConversation={onOpenConversation}
      prNumber={7}
      prState="OPEN"
      prTitle="Add the thing"
      prUrl={PR_URL}
      unresolvedThreads={unresolvedThreads}
    />
  )

const ONE_THREAD = /1 unresolved conversation$/
const THREE_THREADS = /3 unresolved conversations/
const ANY_UNRESOLVED = /unresolved/

describe('unresolved conversations on the pull request badge', () => {
  afterEach(() => {
    cleanup()
  })

  it('counts the threads still waiting on someone', () => {
    renderBadge(3)

    expect(screen.getByLabelText(THREE_THREADS).textContent).toContain('3')
  })

  it('reads one thread as a conversation, not conversations', () => {
    renderBadge(1)

    expect(screen.getByLabelText(ONE_THREAD)).toBeTruthy()
  })

  it('sends the reader to the diff, where threads are answered', () => {
    renderBadge(2)

    expect(screen.getByLabelText(ANY_UNRESOLVED).getAttribute('href')).toBe(
      `${PR_URL}/files`
    )
  })

  it('opens the conversation in the app rather than the browser', () => {
    const onOpenConversation = vi.fn()
    renderBadge(2, onOpenConversation)

    const clicked = fireEvent.click(screen.getByLabelText(ANY_UNRESOLVED))

    expect(onOpenConversation).toHaveBeenCalledTimes(1)
    // The navigation the anchor would otherwise perform was called off.
    expect(clicked).toBe(false)
  })

  it('leaves the modifier click to GitHub', () => {
    const onOpenConversation = vi.fn()
    renderBadge(2, onOpenConversation)

    fireEvent.click(screen.getByLabelText(ANY_UNRESOLVED), { metaKey: true })

    expect(onOpenConversation).not.toHaveBeenCalled()
  })

  it('falls back to GitHub where there is no pane to open', () => {
    renderBadge(2)

    const segment = screen.getByLabelText(ANY_UNRESOLVED)
    const clicked = fireEvent.click(segment)

    expect(segment.getAttribute('target')).toBe('_blank')
    // Nothing intercepted the click, so the link is the whole behaviour.
    expect(clicked).toBe(true)
  })

  it('does not leak the referrer to the pages it opens', () => {
    renderBadge(2)

    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    }
  })

  it('stays out of the amber the checks segment owns', () => {
    renderBadge(2)

    expect(screen.getByLabelText(ANY_UNRESOLVED).className).not.toContain(
      'text-warning'
    )
  })

  it('says nothing once every conversation is resolved', () => {
    renderBadge(0)

    expect(screen.queryByLabelText(ANY_UNRESOLVED)).toBeNull()
  })

  it('says nothing when the threads were never read', () => {
    renderBadge(null)

    expect(screen.queryByLabelText(ANY_UNRESOLVED)).toBeNull()
  })

  it('still shows the pull request itself', () => {
    renderBadge(null)

    expect(screen.getByText('#7')).toBeTruthy()
  })
})
