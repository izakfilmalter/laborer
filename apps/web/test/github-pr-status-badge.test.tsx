import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { GitHubPrStatusBadge } from '@/components/github-pr-status-badge'

const PR_URL = 'https://github.com/acme/widgets/pull/7'

const renderBadge = (unresolvedThreads: number | null) =>
  render(
    <GitHubPrStatusBadge
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
