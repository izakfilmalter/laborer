/**
 * What a reader and a keyboard get out of an inline review conversation.
 *
 * The whole point of the pane is that a human note and an agent answer are
 * never confused, and that every action on a thread is reachable without a
 * pointer — the one thing the diff viewer's shadow-root gutter cannot offer.
 */

import type { ReviewCommentThread } from '@laborer/shared/rpc'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DiffCommentAnnotation,
  DiffCommentComposer,
  DiffCommentThreadCard,
} from '@/components/diff-comment-annotation'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const NOW = 1_700_000_000_000

const COLLAPSED_REPLY_COUNT = /1 more reply/
const REPLY_BUTTON = /^Reply/
const RESOLVE_BUTTON = /^Resolve/

const thread = (
  overrides: Partial<ReviewCommentThread> & { readonly id: string }
): ReviewCommentThread => ({
  createdAt: NOW - 60_000,
  endLine: 9,
  filePath: 'src/example.ts',
  replies: [
    {
      author: 'human',
      body: 'Why is this cached?',
      createdAt: NOW - 60_000,
      id: `${overrides.id}-human`,
      threadId: overrides.id,
    },
  ],
  revision: 1,
  side: 'additions',
  startLine: 4,
  status: 'open',
  updatedAt: NOW - 60_000,
  workspaceId: 'workspace-one',
  ...overrides,
})

const withAgentReply = (base: ReviewCommentThread): ReviewCommentThread => ({
  ...base,
  replies: [
    ...base.replies,
    {
      author: 'agent',
      body: 'The upstream call is rate limited.',
      createdAt: NOW - 30_000,
      id: `${base.id}-agent`,
      threadId: base.id,
    },
  ],
})

const renderCard = (
  overrides?: Partial<Parameters<typeof DiffCommentThreadCard>[0]>
) => {
  const props = {
    busy: false,
    now: NOW,
    onDelete: vi.fn(),
    onReply: vi.fn(),
    onSetStatus: vi.fn(),
    thread: thread({ id: 'thread-one' }),
    ...overrides,
  }
  render(<DiffCommentThreadCard {...props} />)
  return props
}

describe('review conversation', () => {
  it('names both authors, so the distinction survives without colour', () => {
    renderCard({ thread: withAgentReply(thread({ id: 'thread-one' })) })

    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.getByText('Agent')).toBeTruthy()
  })

  it('marks each reply with its author for a reader who cannot see hue', () => {
    renderCard({ thread: withAgentReply(thread({ id: 'thread-one' })) })

    const authors = [
      ...document.querySelectorAll('[data-review-comment-author]'),
    ].map((node) => node.getAttribute('data-review-comment-author'))
    expect(authors).toEqual(['human', 'agent'])
  })

  it('keeps replies in the order they were written', () => {
    renderCard({ thread: withAgentReply(thread({ id: 'thread-one' })) })

    const bodies = [
      ...document.querySelectorAll('[data-review-comment-author]'),
    ].map((node) => node.textContent)
    expect(bodies[0]).toContain('Why is this cached?')
    expect(bodies[1]).toContain('The upstream call is rate limited.')
  })

  it('gives reply, resolve, and delete accessible names that say where', () => {
    // Several conversations can share one annotation, so "Resolve" alone would
    // not tell a screen-reader user which one is about to close.
    renderCard()

    expect(
      screen.getByRole('button', {
        name: 'Reply to the review comment on src/example.ts:4-9',
      })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Resolve the review comment on src/example.ts:4-9',
      })
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Delete the review comment on src/example.ts:4-9',
      })
    ).toBeTruthy()
  })

  it('reaches every control by keyboard alone', async () => {
    const user = userEvent.setup()
    const props = renderCard()

    await user.tab()
    await user.keyboard('{Enter}')
    expect(props.onReply).toHaveBeenCalledWith(props.thread)

    await user.tab()
    await user.keyboard('{Enter}')
    expect(props.onSetStatus).toHaveBeenCalledWith(props.thread, 'resolved')

    await user.tab()
    await user.keyboard('{Enter}')
    expect(props.onDelete).toHaveBeenCalledWith(props.thread)
  })

  it('dims a resolved thread and collapses it to its opening note', () => {
    // Resolved is evidence of what was asked, so it quiets rather than
    // disappears; the toolbar's toggle is the way back to it.
    const resolved = withAgentReply(
      thread({ id: 'thread-one', status: 'resolved' })
    )
    renderCard({ thread: resolved })

    expect(screen.getByText('Resolved')).toBeTruthy()
    expect(screen.getByText('Why is this cached?')).toBeTruthy()
    expect(screen.queryByText('The upstream call is rate limited.')).toBeNull()
    expect(screen.getByText(COLLAPSED_REPLY_COUNT)).toBeTruthy()
  })

  it('offers a resolved thread the way back open', () => {
    const props = renderCard({
      thread: thread({ id: 'thread-one', status: 'resolved' }),
    })
    screen
      .getByRole('button', {
        name: 'Reopen the review comment on src/example.ts:4-9',
      })
      .click()
    expect(props.onSetStatus).toHaveBeenCalledWith(props.thread, 'open')
  })

  it('holds every control while a write is in flight', () => {
    renderCard({ busy: true })

    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
  })

  it('drops the reply button where there is nowhere to put a composer', () => {
    // The detached list has no annotation slot, but the words still read and
    // the thread can still be resolved or deleted.
    renderCard({ onReply: undefined })

    expect(screen.queryByRole('button', { name: REPLY_BUTTON })).toBeNull()
    expect(screen.getByRole('button', { name: RESOLVE_BUTTON })).toBeTruthy()
  })
})

describe('composer', () => {
  const renderComposer = (
    overrides?: Partial<Parameters<typeof DiffCommentComposer>[0]>
  ) => {
    const props = {
      anchorLabel: 'src/example.ts:4-9',
      busy: false,
      onCancel: vi.fn(),
      onChange: vi.fn(),
      onSubmit: vi.fn(),
      value: '',
      ...overrides,
    }
    render(<DiffCommentComposer {...props} />)
    return {
      ...props,
      input: screen.getByRole('textbox', {
        name: `Comment on ${props.anchorLabel}`,
      }),
    }
  }

  it('names the lines it is about, and takes focus it was asked for', () => {
    const { input } = renderComposer()
    expect(document.activeElement).toBe(input)
  })

  it('refuses to send an empty body', () => {
    renderComposer()
    expect(
      (screen.getByTestId('diff-comment-composer-submit') as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it('sends the trimmed body from the button', async () => {
    const user = userEvent.setup()
    const props = renderComposer({ value: '  ship it  ' })

    await user.click(screen.getByTestId('diff-comment-composer-submit'))
    expect(props.onSubmit).toHaveBeenCalledWith('ship it')
  })

  it('sends on Command+Enter but leaves plain Enter as a newline', async () => {
    const user = userEvent.setup()
    const props = renderComposer({ value: 'ship it' })

    await user.type(props.input, '{Enter}')
    expect(props.onSubmit).not.toHaveBeenCalled()

    await user.type(props.input, '{Meta>}{Enter}{/Meta}')
    expect(props.onSubmit).toHaveBeenCalledWith('ship it')
  })

  it('cancels on Escape without losing the words anywhere else', async () => {
    const user = userEvent.setup()
    const props = renderComposer({ value: 'half a thought' })

    await user.type(props.input, '{Escape}')
    expect(props.onCancel).toHaveBeenCalled()
    expect(props.onSubmit).not.toHaveBeenCalled()
  })

  it('blocks a second submit while the first is in flight', async () => {
    const user = userEvent.setup()
    const props = renderComposer({ busy: true, value: 'ship it' })

    await user.type(props.input, '{Meta>}{Enter}{/Meta}')
    expect(props.onSubmit).not.toHaveBeenCalled()
  })
})

describe('annotation group', () => {
  const group = {
    label: 'src/example.ts:4-9',
    threads: [
      thread({ createdAt: NOW - 90_000, id: 'first' }),
      thread({ createdAt: NOW - 60_000, id: 'second' }),
    ],
  }

  const renderGroup = (
    overrides?: Partial<Parameters<typeof DiffCommentAnnotation>[0]>
  ) =>
    render(
      <DiffCommentAnnotation
        busy={false}
        group={group}
        now={NOW}
        onDelete={vi.fn()}
        onReply={vi.fn()}
        onSetStatus={vi.fn()}
        {...overrides}
      />
    )

  it('paints every conversation sharing the line', () => {
    // The viewer renders one node per (side, line), so a group that dropped a
    // thread would lose it with no other place for it to appear.
    renderGroup()
    expect(screen.getAllByTestId('diff-comment-thread')).toHaveLength(2)
  })

  it('puts a new comment under the conversations already there', () => {
    renderGroup({ composer: <div data-testid="composer" /> })

    const nodes = [
      ...document.querySelectorAll(
        '[data-testid="diff-comment-thread"],[data-testid="composer"]'
      ),
    ].map((node) => node.getAttribute('data-testid'))
    expect(nodes).toEqual([
      'diff-comment-thread',
      'diff-comment-thread',
      'composer',
    ])
  })

  it('puts a reply inside the thread it answers', () => {
    renderGroup({
      composer: <div data-testid="composer" />,
      replyingToThreadId: 'first',
    })

    const threads = screen.getAllByTestId('diff-comment-thread')
    expect(threads[0]?.querySelector('[data-testid="composer"]')).toBeTruthy()
    expect(threads[1]?.querySelector('[data-testid="composer"]')).toBeNull()
  })
})
