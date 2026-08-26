import type { ReviewCommentThread } from '@laborer/shared/rpc'
import type { FileDiffMetadata } from '@pierre/diffs'
import { beforeAll, describe, expect, it } from 'vitest'
import type { DiffCommentAnchor } from '@/lib/diff-comment-anchor'
import {
  detachedLineProbes,
  diffCommentAnnotationsVersion,
  groupDiffCommentThreads,
  isDiffLineRendered,
  orderDiffCommentThreads,
  partitionDiffCommentThreads,
  selectDiffCommentThreads,
  threadsOutsideDiff,
  withDraftDiffCommentAnnotation,
} from '@/lib/diff-comment-threads'
import { renderedLineKey } from '@/lib/diff-expansion'

beforeAll(() => {
  // `@pierre/diffs` builds a constructable stylesheet at import time.
  if (typeof CSSStyleSheet.prototype.replaceSync === 'function') {
    return
  }
  Object.defineProperty(CSSStyleSheet.prototype, 'replaceSync', {
    configurable: true,
    value() {
      return undefined
    },
  })
})

const thread = (
  overrides: Partial<ReviewCommentThread> & { readonly id: string }
): ReviewCommentThread => ({
  createdAt: 100,
  endLine: 4,
  filePath: 'src/example.ts',
  replies: [
    {
      author: 'human',
      body: 'why this?',
      createdAt: 100,
      id: `${overrides.id}-reply`,
      threadId: overrides.id,
    },
  ],
  revision: 1,
  side: 'additions',
  startLine: 4,
  status: 'open',
  updatedAt: 100,
  workspaceId: 'workspace-one',
  ...overrides,
})

/**
 * A real parsed diff, so the "is this line rendered" question is answered by
 * the same parser the pane uses rather than by a hand-built shape.
 *
 * Additions land on lines 4-5; the file has no other hunk.
 */
const parsedDiff = async (): Promise<FileDiffMetadata> => {
  const { parseFileDiffEntry } = await import('@/lib/file-diff')
  const patch = parseFileDiffEntry({
    added: 2,
    path: 'src/example.ts',
    patch: [
      'diff --git a/src/example.ts b/src/example.ts',
      'index 1111111..2222222 100644',
      '--- a/src/example.ts',
      '+++ b/src/example.ts',
      '@@ -3,2 +3,4 @@',
      ' const first = 1',
      '-const second = 2',
      '+const second = 22',
      '+const third = 3',
      '+const fourth = 4',
      '',
    ].join('\n'),
    removed: 1,
    status: 'modified',
    truncated: false,
  })
  if (patch.kind !== 'parsed') {
    throw new Error('fixture patch did not parse')
  }
  return patch.fileDiff
}

describe('orderDiffCommentThreads', () => {
  it('reads oldest first', () => {
    const ordered = orderDiffCommentThreads([
      thread({ createdAt: 300, id: 'c' }),
      thread({ createdAt: 100, id: 'a' }),
      thread({ createdAt: 200, id: 'b' }),
    ])
    expect(ordered.map(({ id }) => id)).toEqual(['a', 'b', 'c'])
  })

  it('breaks a same-millisecond tie by id so the order never flickers', () => {
    const ordered = orderDiffCommentThreads([
      thread({ createdAt: 100, id: 'zebra' }),
      thread({ createdAt: 100, id: 'apple' }),
    ])
    expect(ordered.map(({ id }) => id)).toEqual(['apple', 'zebra'])
  })

  it('leaves the input array alone', () => {
    const input = [
      thread({ createdAt: 300, id: 'c' }),
      thread({ createdAt: 100, id: 'a' }),
    ]
    orderDiffCommentThreads(input)
    expect(input.map(({ id }) => id)).toEqual(['c', 'a'])
  })
})

describe('selectDiffCommentThreads', () => {
  const rows = [
    thread({ id: 'mine' }),
    thread({ id: 'other-workspace', workspaceId: 'workspace-two' }),
    thread({ createdAt: 200, id: 'mine-resolved', status: 'resolved' }),
  ]

  it('keeps only this workspace, and hides resolved by default', () => {
    // The shared stream carries every workspace's conversations, so the
    // workspace filter is not optional.
    expect(
      selectDiffCommentThreads(rows, {
        includeResolved: false,
        workspaceId: 'workspace-one',
      }).map(({ id }) => id)
    ).toEqual(['mine'])
  })

  it('reveals resolved threads on request without crossing workspaces', () => {
    expect(
      selectDiffCommentThreads(rows, {
        includeResolved: true,
        workspaceId: 'workspace-one',
      }).map(({ id }) => id)
    ).toEqual(['mine', 'mine-resolved'])
  })
})

describe('groupDiffCommentThreads', () => {
  it('renders several conversations on one line as a single annotation', () => {
    // The viewer paints at most one node per (side, line), so two threads on
    // the same line have to arrive together or one of them disappears.
    const annotations = groupDiffCommentThreads([
      thread({ createdAt: 200, endLine: 4, id: 'second', startLine: 4 }),
      thread({ createdAt: 100, endLine: 4, id: 'first', startLine: 2 }),
    ])

    expect(annotations).toHaveLength(1)
    expect(annotations[0]?.metadata.threads.map(({ id }) => id)).toEqual([
      'first',
      'second',
    ])
  })

  it('labels a group with the widest range its threads cover', () => {
    const annotations = groupDiffCommentThreads([
      thread({ createdAt: 100, endLine: 8, id: 'wide', startLine: 3 }),
      thread({ createdAt: 200, endLine: 8, id: 'narrow', startLine: 7 }),
    ])
    expect(annotations[0]?.metadata.label).toBe('src/example.ts:3-8')
  })

  it('keeps the two sides of one line apart', () => {
    const annotations = groupDiffCommentThreads([
      thread({ endLine: 4, id: 'added', side: 'additions', startLine: 4 }),
      thread({ endLine: 4, id: 'removed', side: 'deletions', startLine: 4 }),
    ])
    expect(annotations.map((annotation) => annotation.side)).toEqual([
      'additions',
      'deletions',
    ])
  })

  it('anchors a range to its last line, where the gutter button sits', () => {
    const annotations = groupDiffCommentThreads([
      thread({ endLine: 9, id: 'range', startLine: 4 }),
    ])
    expect(annotations[0]?.lineNumber).toBe(9)
  })

  it('orders annotations by line so the array is stable across renders', () => {
    const annotations = groupDiffCommentThreads([
      thread({ endLine: 12, id: 'late', startLine: 12 }),
      thread({ endLine: 3, id: 'early', startLine: 3 }),
    ])
    expect(annotations.map(({ lineNumber }) => lineNumber)).toEqual([3, 12])
  })
})

describe('isDiffLineRendered', () => {
  it('accepts a line the hunk paints and refuses one outside every hunk', async () => {
    const fileDiff = await parsedDiff()
    expect(isDiffLineRendered(fileDiff, 'additions', 4)).toBe(true)
    expect(isDiffLineRendered(fileDiff, 'additions', 900)).toBe(false)
  })

  it('accepts a line outside every hunk once the viewer reports painting it', async () => {
    // Expansion leaves `additionStart`/`additionCount` exactly as they were,
    // so the hunks can never answer this on their own.
    const fileDiff = await parsedDiff()
    const expanded = new Set([renderedLineKey('additions', 40)])
    expect(isDiffLineRendered(fileDiff, 'additions', 40, expanded)).toBe(true)
    expect(isDiffLineRendered(fileDiff, 'deletions', 40, expanded)).toBe(false)
  })
})

describe('partitionDiffCommentThreads', () => {
  it('separates threads with a line to sit on from threads without one', async () => {
    // Server-side re-anchoring is out of scope, so a thread whose line moved
    // out of every hunk has to be listed rather than silently dropped.
    const fileDiff = await parsedDiff()
    const partition = partitionDiffCommentThreads(fileDiff, [
      thread({ endLine: 4, id: 'placed', startLine: 4 }),
      thread({ endLine: 900, id: 'drifted', startLine: 900 }),
    ])

    expect(
      partition.annotations.flatMap((annotation) =>
        annotation.metadata.threads.map(({ id }) => id)
      )
    ).toEqual(['placed'])
    expect(partition.detached.map(({ id }) => id)).toEqual(['drifted'])
  })

  it('detaches a thread whose side no longer has that line', async () => {
    const fileDiff = await parsedDiff()
    const partition = partitionDiffCommentThreads(fileDiff, [
      thread({ endLine: 5, id: 'wrong-side', side: 'deletions', startLine: 5 }),
    ])
    expect(partition.detached.map(({ id }) => id)).toEqual(['wrong-side'])
  })

  it('re-attaches a thread the reader expanded back into view', async () => {
    // The reason this matters: without it, expanding the context around a
    // comment paints its line and leaves a banner insisting the comment is
    // not in this diff, while the reader is looking straight at the line.
    const fileDiff = await parsedDiff()
    const threads = [thread({ endLine: 40, id: 'in-the-gap', startLine: 40 })]

    expect(
      partitionDiffCommentThreads(fileDiff, threads).detached.map(
        ({ id }) => id
      )
    ).toEqual(['in-the-gap'])

    const expanded = partitionDiffCommentThreads(
      fileDiff,
      threads,
      new Set([renderedLineKey('additions', 40)])
    )
    expect(expanded.detached).toEqual([])
    expect(
      expanded.annotations.flatMap((annotation) =>
        annotation.metadata.threads.map(({ id }) => id)
      )
    ).toEqual(['in-the-gap'])
  })

  it('leaves a thread in a gap nobody expanded alone', async () => {
    const fileDiff = await parsedDiff()
    const partition = partitionDiffCommentThreads(
      fileDiff,
      [thread({ endLine: 40, id: 'still-hidden', startLine: 40 })],
      new Set([renderedLineKey('additions', 41)])
    )
    expect(partition.detached.map(({ id }) => id)).toEqual(['still-hidden'])
  })
})

describe('detachedLineProbes', () => {
  it('asks only about the lines expansion could move', async () => {
    // A thread the hunks already place cannot be changed by expansion, so
    // probing it would be a question with a known answer on every repaint.
    const fileDiff = await parsedDiff()
    expect(
      detachedLineProbes(fileDiff, [
        thread({ endLine: 4, id: 'placed', startLine: 4 }),
        thread({ endLine: 40, id: 'in-the-gap', startLine: 40 }),
      ])
    ).toEqual([{ lineNumber: 40, side: 'additions' }])
  })

  it('asks once for several threads sharing a line', async () => {
    const fileDiff = await parsedDiff()
    expect(
      detachedLineProbes(fileDiff, [
        thread({ endLine: 40, id: 'one', startLine: 40 }),
        thread({ endLine: 40, id: 'two', startLine: 38 }),
      ])
    ).toHaveLength(1)
  })

  it('keeps the two sides of one line apart', async () => {
    const fileDiff = await parsedDiff()
    expect(
      detachedLineProbes(fileDiff, [
        thread({ endLine: 40, id: 'added', side: 'additions', startLine: 40 }),
        thread({
          endLine: 40,
          id: 'removed',
          side: 'deletions',
          startLine: 40,
        }),
      ])
    ).toEqual([
      { lineNumber: 40, side: 'additions' },
      { lineNumber: 40, side: 'deletions' },
    ])
  })
})

describe('withDraftDiffCommentAnnotation', () => {
  const anchor: DiffCommentAnchor = {
    endLine: 7,
    filePath: 'src/example.ts',
    label: 'src/example.ts:7',
    side: 'additions',
    startLine: 7,
  }

  it('opens a slot on a line that has no conversation yet', () => {
    const annotations = withDraftDiffCommentAnnotation([], anchor)
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({
      lineNumber: 7,
      metadata: { label: 'src/example.ts:7', threads: [] },
      side: 'additions',
    })
  })

  it('reuses the existing group so the composer joins the conversation', () => {
    const existing = groupDiffCommentThreads([
      thread({ endLine: 7, id: 'already-here', startLine: 7 }),
    ])
    expect(withDraftDiffCommentAnnotation(existing, anchor)).toBe(existing)
  })

  it('keeps the added slot in line order', () => {
    const existing = groupDiffCommentThreads([
      thread({ endLine: 12, id: 'later', startLine: 12 }),
    ])
    expect(
      withDraftDiffCommentAnnotation(existing, anchor).map(
        ({ lineNumber }) => lineNumber
      )
    ).toEqual([7, 12])
  })

  it('does not reuse a group on the other side of the same line', () => {
    const existing = groupDiffCommentThreads([
      thread({ endLine: 7, id: 'deleted', side: 'deletions', startLine: 7 }),
    ])
    expect(withDraftDiffCommentAnnotation(existing, anchor)).toHaveLength(2)
  })
})

describe('diffCommentAnnotationsVersion', () => {
  const base = groupDiffCommentThreads([thread({ id: 'one' })])

  it('is stable for the same annotations', () => {
    expect(diffCommentAnnotationsVersion(base)).toBe(
      diffCommentAnnotationsVersion(
        groupDiffCommentThreads([thread({ id: 'one' })])
      )
    )
  })

  it('changes when an agent reply arrives, which is the live case', () => {
    // Nothing else about the item moves when a reply lands over MCP, so the
    // viewer would never re-read the item if the version ignored replies.
    const replied = groupDiffCommentThreads([
      thread({
        id: 'one',
        replies: [
          {
            author: 'human',
            body: 'why this?',
            createdAt: 100,
            id: 'one-reply',
            threadId: 'one',
          },
          {
            author: 'agent',
            body: 'because of the cache',
            createdAt: 200,
            id: 'one-agent',
            threadId: 'one',
          },
        ],
      }),
    ])
    expect(diffCommentAnnotationsVersion(replied)).not.toBe(
      diffCommentAnnotationsVersion(base)
    )
  })

  it('changes when a thread is resolved', () => {
    const resolved = groupDiffCommentThreads([
      thread({ id: 'one', revision: 2, status: 'resolved' }),
    ])
    expect(diffCommentAnnotationsVersion(resolved)).not.toBe(
      diffCommentAnnotationsVersion(base)
    )
  })

  it('changes when a composer opens on an untouched line', () => {
    const withDraft = withDraftDiffCommentAnnotation([], {
      endLine: 7,
      filePath: 'src/example.ts',
      label: 'src/example.ts:7',
      side: 'additions',
      startLine: 7,
    })
    expect(diffCommentAnnotationsVersion(withDraft)).not.toBe(
      diffCommentAnnotationsVersion([])
    )
  })
})

describe('threads on files the current diff does not contain', () => {
  const byFile = new Map<string, readonly ReviewCommentThread[]>([
    ['src/committed.ts', [thread({ id: 'committed-one' })]],
    [
      'src/shared.ts',
      [
        thread({ createdAt: 200, id: 'shared-one' }),
        thread({ id: 'shared-two' }),
      ],
    ],
    ['src/also-gone.ts', [thread({ id: 'gone-one' })]],
  ])

  it('collects every thread whose file is absent from the diff', () => {
    // Ordered by path, so the list does not reshuffle between renders.
    expect(
      threadsOutsideDiff(byFile, new Set(['src/shared.ts'])).map(
        (found) => found.id
      )
    ).toEqual(['gone-one', 'committed-one'])
  })

  it('keeps nothing when every file is in the diff', () => {
    expect(
      threadsOutsideDiff(
        byFile,
        new Set(['src/committed.ts', 'src/shared.ts', 'src/also-gone.ts'])
      )
    ).toEqual([])
  })

  it('orders a multi-thread file oldest first, like every other list', () => {
    expect(
      threadsOutsideDiff(byFile, new Set(['src/committed.ts'])).map(
        (found) => found.id
      )
    ).toEqual(['gone-one', 'shared-two', 'shared-one'])
  })
})
