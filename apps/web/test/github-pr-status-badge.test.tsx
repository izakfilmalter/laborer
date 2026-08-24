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

  it('turns the card segment into a conversation hover preview', () => {
    render(
      <GitHubPrStatusBadge
        conversationWorkspaceId="ws-7"
        onOpenConversation={vi.fn()}
        prNumber={7}
        prState="OPEN"
        prTitle="Add the thing"
        prUrl={PR_URL}
        unresolvedThreads={2}
      />
    )

    expect(
      screen.getByLabelText(ANY_UNRESOLVED).getAttribute('data-slot')
    ).toBe('hover-card-trigger')
  })

  it('uses one conversation preview when review and thread segments coexist', () => {
    render(
      <GitHubPrStatusBadge
        conversationWorkspaceId="ws-7"
        onOpenConversation={vi.fn()}
        prNumber={7}
        prState="OPEN"
        prTitle="Add the thing"
        prUrl={PR_URL}
        reviewDecision="changesRequested"
        unresolvedThreads={2}
      />
    )

    expect(
      document.querySelectorAll('[data-slot="hover-card-trigger"]')
    ).toHaveLength(1)
    expect(
      screen.getByLabelText(ANY_UNRESOLVED).getAttribute('data-slot')
    ).toBe('hover-card-trigger')
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

const renderReviewBadge = (
  props: {
    readonly approvals?: number | null
    readonly reviewDecision?:
      | 'approved'
      | 'changesRequested'
      | 'reviewRequired'
      | null
  },
  onOpenConversation?: () => void
) =>
  render(
    <GitHubPrStatusBadge
      approvals={props.approvals ?? null}
      onOpenConversation={onOpenConversation}
      prNumber={7}
      prState="OPEN"
      prTitle="Add the thing"
      prUrl={PR_URL}
      reviewDecision={props.reviewDecision ?? null}
    />
  )

const ANY_REVIEW = /Approved|Review required|Changes requested/
const TWO_APPROVALS = /Approved · 2 approvals/
const ONE_APPROVAL = /Approved · 1 approval$/
const CHANGES_REQUESTED = /Changes requested/
const APPROVED = /Approved/

describe('review decision on the pull request badge', () => {
  afterEach(() => {
    cleanup()
  })

  it('counts the approvals standing behind the verdict', () => {
    renderReviewBadge({ approvals: 2, reviewDecision: 'approved' })

    const segment = screen.getByLabelText(TWO_APPROVALS)
    expect(segment.textContent).toContain('2')
  })

  it('reads one approval as an approval, not approvals', () => {
    renderReviewBadge({ approvals: 1, reviewDecision: 'approved' })

    expect(screen.getByLabelText(ONE_APPROVAL)).toBeTruthy()
  })

  it('drops the digit where nobody has approved yet', () => {
    renderReviewBadge({ approvals: 0, reviewDecision: 'reviewRequired' })

    const segment = screen.getByLabelText('Review required')
    expect(segment.textContent).toBe('')
  })

  it('names a change request as the verdict it is', () => {
    renderReviewBadge({ approvals: 1, reviewDecision: 'changesRequested' })

    expect(screen.getByLabelText(CHANGES_REQUESTED)).toBeTruthy()
  })

  it('sends the reader to the conversation, where reviews are read', () => {
    renderReviewBadge({ approvals: 1, reviewDecision: 'approved' })

    expect(screen.getByLabelText(APPROVED).getAttribute('href')).toBe(PR_URL)
  })

  it('opens the conversation in the app rather than the browser', () => {
    const onOpenConversation = vi.fn()
    renderReviewBadge(
      { approvals: 1, reviewDecision: 'approved' },
      onOpenConversation
    )

    fireEvent.click(screen.getByLabelText(APPROVED))

    expect(onOpenConversation).toHaveBeenCalledTimes(1)
  })

  it('names the verdict without repeating where the click goes', () => {
    renderReviewBadge({ approvals: 2, reviewDecision: 'approved' }, vi.fn())

    const segment = screen.getByLabelText(TWO_APPROVALS)
    // The tooltip earns its second line by naming the destination; the
    // accessible name must not say it too.
    expect(segment.getAttribute('aria-label')).toBe('Approved · 2 approvals')
    // A control the keyboard can reach, not a div with a click handler.
    expect(segment.tagName).toBe('A')
  })

  it('says nothing where the pull request asks nobody for review', () => {
    renderReviewBadge({ approvals: null, reviewDecision: null })

    expect(screen.queryByLabelText(ANY_REVIEW)).toBeNull()
    expect(screen.getByText('#7')).toBeTruthy()
  })
})

describe('review decision on a draft pull request', () => {
  afterEach(() => {
    cleanup()
  })

  const renderDraft = (
    reviewDecision: 'approved' | 'reviewRequired' | null,
    approvals: number | null = null
  ) =>
    render(
      <GitHubPrStatusBadge
        approvals={approvals}
        prIsDraft
        prNumber={7}
        prState="OPEN"
        prTitle="Add the thing"
        prUrl={PR_URL}
        reviewDecision={reviewDecision}
      />
    )

  it('asks nobody for a review it has not requested yet', () => {
    renderDraft('reviewRequired')

    expect(screen.queryByLabelText(ANY_REVIEW)).toBeNull()
  })

  it('keeps quiet even when a review already landed on the draft', () => {
    renderDraft('approved', 2)

    expect(screen.queryByLabelText(ANY_REVIEW)).toBeNull()
  })

  it('says draft, so the missing verdict has a reason on the pill', () => {
    renderDraft('reviewRequired')

    expect(screen.getByText('draft')).toBeTruthy()
    expect(screen.queryByText('open')).toBeNull()
  })

  it('stays out of the green reserved for a mergeable pull request', () => {
    const { container } = renderDraft('reviewRequired')

    expect(
      container
        .querySelector('[data-slot="pr-status-badge"]')
        ?.className.includes('bg-success/10')
    ).toBe(false)
  })

  it('speaks again once the draft is marked ready', () => {
    render(
      <GitHubPrStatusBadge
        approvals={0}
        prIsDraft={false}
        prNumber={7}
        prState="OPEN"
        prTitle="Add the thing"
        prUrl={PR_URL}
        reviewDecision="reviewRequired"
      />
    )

    expect(screen.getByLabelText('Review required')).toBeTruthy()
    expect(screen.getByText('open')).toBeTruthy()
  })

  it('is closed rather than draft once it is closed', () => {
    render(
      <GitHubPrStatusBadge
        prIsDraft
        prNumber={7}
        prState="CLOSED"
        prTitle="Add the thing"
        prUrl={PR_URL}
        reviewDecision="reviewRequired"
      />
    )

    expect(screen.getByText('closed')).toBeTruthy()
    expect(screen.queryByText('draft')).toBeNull()
  })
})

describe('review decision on a pull request that is over', () => {
  afterEach(() => {
    cleanup()
  })

  it('drops the verdict once the pull request is merged', () => {
    render(
      <GitHubPrStatusBadge
        approvals={2}
        prNumber={7}
        prState="MERGED"
        prTitle="Add the thing"
        prUrl={PR_URL}
        reviewDecision="approved"
      />
    )

    // Nobody is waiting on a review of work that already landed.
    expect(screen.queryByLabelText(ANY_REVIEW)).toBeNull()
    expect(screen.getByText('merged')).toBeTruthy()
  })
})
