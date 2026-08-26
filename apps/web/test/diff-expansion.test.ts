/**
 * The seam between the pane and `@pierre/diffs`' live expansion state.
 *
 * Half of this file is ordinary unit testing of pure line arithmetic. The
 * other half — `describe('the contract with @pierre/diffs')` — is a pin: it
 * asserts, against the installed version, that the library still has the
 * public surface `@/lib/diff-expansion` reads and that it still behaves the
 * way that module assumes. A version bump that moves any of it fails here,
 * with a sentence saying what moved, instead of silently telling readers
 * their review comments are not in the diff they are looking at.
 */

import {
  CodeView,
  FileDiff,
  type FileDiffMetadata,
  type HunkExpansionRegion,
  hydratePartialDiff,
  parsePatchFiles,
  VirtualizedFileDiff,
} from '@pierre/diffs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  additionLineTwin,
  asDiffLineRenderOracle,
  probeExpandedLines,
  renderedLineKey,
  renderedLinesSignature,
} from '@/lib/diff-expansion'

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

// ---------------------------------------------------------------------------
// A file with a small change surrounded by many unchanged lines — the shape
// hunk expansion exists for.
// ---------------------------------------------------------------------------

const FILE_LINES = 30
const CHANGED_LINE = 15
const PATH = 'src/example.ts'

const lines = Array.from(
  { length: FILE_LINES },
  (_, index) => `line ${index + 1}`
)
const oldContents = `${lines.join('\n')}\n`
const newContents = `${lines
  .map((line, index) => (index === CHANGED_LINE - 1 ? `${line} changed` : line))
  .join('\n')}\n`

/**
 * Three lines of context either side of line 15, so lines 1-11 are a
 * collapsed gap before the hunk and lines 19-30 a collapsed gap after it.
 */
const PATCH = [
  `diff --git a/${PATH} b/${PATH}`,
  'index 1111111..2222222 100644',
  `--- a/${PATH}`,
  `+++ b/${PATH}`,
  '@@ -12,7 +12,7 @@',
  ' line 12',
  ' line 13',
  ' line 14',
  '-line 15',
  '+line 15 changed',
  ' line 16',
  ' line 17',
  ' line 18',
  '',
].join('\n')

const partialDiff = (): FileDiffMetadata => {
  const parsed = parsePatchFiles(PATCH, 'diff-expansion-fixture').flatMap(
    (entry) => entry.files
  )[0]
  if (parsed === undefined) {
    throw new Error('fixture patch did not parse')
  }
  return parsed
}

const hydratedDiff = (): FileDiffMetadata =>
  hydratePartialDiff('merge', partialDiff(), {
    newFile: { contents: newContents, name: PATH },
    oldFile: { contents: oldContents, name: PATH },
  })

const oracleFor = (
  fileDiff: FileDiffMetadata,
  expanded: ReadonlyMap<number, HunkExpansionRegion> = new Map()
) => asDiffLineRenderOracle(FileDiff.prototype, fileDiff, expanded)

/** One press upwards on the separator, generously overshooting the gap. */
const EXPANDED_LEADING_GAP = new Map<number, HunkExpansionRegion>([
  [0, { fromEnd: 0, fromStart: 40 }],
])

/** The trailing region is keyed one past the last hunk, by the library. */
const EXPANDED_TRAILING_GAP = new Map<number, HunkExpansionRegion>([
  [1, { fromEnd: 0, fromStart: 40 }],
])

// ---------------------------------------------------------------------------

describe('the contract with @pierre/diffs', () => {
  it('still exposes the public route the pane reads expansion through', () => {
    // `@/lib/diff-expansion` walks CodeView.getRenderedItems() and asks each
    // mounted VirtualizedFileDiff whether a line has a row. Losing either
    // means the pane can no longer tell an expanded line from a hidden one.
    expect(
      typeof CodeView.prototype.getRenderedItems,
      'CodeView.getRenderedItems is gone — @/lib/diff-expansion cannot reach the mounted files'
    ).toBe('function')
    expect(
      typeof VirtualizedFileDiff.prototype.isLineRenderable,
      'VirtualizedFileDiff.isLineRenderable is gone — @/lib/diff-expansion has no supported way to ask what is painted'
    ).toBe('function')
    expect(
      typeof FileDiff.prototype.isLineRenderable,
      'FileDiff.isLineRenderable is gone — @/lib/diff-expansion has no supported way to ask what is painted'
    ).toBe('function')
  })

  it('answers true for every line of a partial diff, which is why partials are never asked', () => {
    // This is the assumption `probeExpandedLines` guards: a patch that has
    // not been hydrated has no expansion model, so the oracle says yes to
    // everything. Reading that as "the comment is attached" would re-attach
    // every drifted comment in the pane.
    const oracle = oracleFor(partialDiff())
    expect(
      oracle.isLineRenderable(5),
      'a partial diff no longer reports every line renderable — the guard in probeExpandedLines may now be hiding real answers'
    ).toBe(true)
  })

  it('answers false for a collapsed gap and true once it is expanded', () => {
    const fileDiff = hydratedDiff()

    expect(
      oracleFor(fileDiff).isLineRenderable(5),
      'a line inside a collapsed gap is reported renderable — expansion no longer changes the answer'
    ).toBe(false)
    expect(oracleFor(fileDiff).isLineRenderable(25)).toBe(false)
    expect(oracleFor(fileDiff).isLineRenderable(14)).toBe(true)

    expect(
      oracleFor(fileDiff, EXPANDED_LEADING_GAP).isLineRenderable(5),
      'expanding the leading gap no longer makes its lines renderable'
    ).toBe(true)
    expect(
      oracleFor(fileDiff, EXPANDED_TRAILING_GAP).isLineRenderable(25),
      'the trailing region is no longer keyed one past the last hunk'
    ).toBe(true)
  })

  it('answers true past the end of the file, which is why the probe bounds first', () => {
    // Documented library behaviour: out-of-range lines report renderable so
    // callers keep their own missing-row handling. A drifted comment far
    // past the end of a file would otherwise re-attach to nothing.
    expect(
      oracleFor(hydratedDiff()).isLineRenderable(FILE_LINES + 500),
      'out-of-range lines are no longer reported renderable — the bound check in probeExpandedLines may now be redundant'
    ).toBe(true)
  })

  it('leaves the hunk line numbers alone when it hydrates, which is the whole problem', () => {
    // If hydration ever did rewrite these, the hunks-only partition would
    // start answering correctly on its own and this seam could go.
    const before = partialDiff().hunks.map((hunk) => ({
      additionCount: hunk.additionCount,
      additionStart: hunk.additionStart,
    }))
    const after = hydratedDiff().hunks.map((hunk) => ({
      additionCount: hunk.additionCount,
      additionStart: hunk.additionStart,
    }))
    expect(after).toEqual(before)
  })
})

describe('additionLineTwin', () => {
  it('pairs a deletion-side context line with the row it shares', () => {
    const fileDiff = hydratedDiff()
    expect(additionLineTwin(fileDiff, 5)).toBe(5)
    expect(additionLineTwin(fileDiff, 25)).toBe(25)
  })

  it('refuses a line inside a hunk, which the hunks have already answered', () => {
    expect(additionLineTwin(hydratedDiff(), CHANGED_LINE)).toBeNull()
  })

  it('carries the offset a hunk opened between the two sides', () => {
    // A hunk that inserts two lines leaves the context before it aligned and
    // pushes every line after it two further down the new file. Getting this
    // wrong would place a deletion-side comment on the wrong row.
    const fileDiff = hydratedDiff()
    const [hunk] = fileDiff.hunks
    if (hunk === undefined) {
      throw new Error('fixture lost its hunk')
    }
    hunk.additionCount = hunk.deletionCount + 2
    expect(additionLineTwin(fileDiff, 5)).toBe(5)
    expect(additionLineTwin(fileDiff, 25)).toBe(27)
  })

  it('has no answer for a file with no hunks at all', () => {
    const fileDiff = hydratedDiff()
    fileDiff.hunks = []
    expect(additionLineTwin(fileDiff, 5)).toBeNull()
  })
})

describe('probeExpandedLines', () => {
  const probes = [
    { lineNumber: 5, side: 'additions' as const },
    { lineNumber: 5, side: 'deletions' as const },
    { lineNumber: 25, side: 'additions' as const },
  ]

  it('finds nothing while the gaps are still collapsed', () => {
    const fileDiff = hydratedDiff()
    expect([
      ...probeExpandedLines(fileDiff, oracleFor(fileDiff), probes),
    ]).toEqual([])
  })

  it('reports both sides of a gap the reader expanded', () => {
    const fileDiff = hydratedDiff()
    const rendered = probeExpandedLines(
      fileDiff,
      oracleFor(fileDiff, EXPANDED_LEADING_GAP),
      probes
    )
    expect([...rendered].sort()).toEqual(['additions:5', 'deletions:5'])
  })

  it('never answers for a partial diff, however the oracle replies', () => {
    // The oracle would say yes to all three; a partial file has to keep
    // being answered by its hunks alone.
    const fileDiff = partialDiff()
    expect([
      ...probeExpandedLines(fileDiff, oracleFor(fileDiff), probes),
    ]).toEqual([])
  })

  it('rejects a line the file does not have, which the oracle would accept', () => {
    const fileDiff = hydratedDiff()
    const rendered = probeExpandedLines(
      fileDiff,
      oracleFor(fileDiff, EXPANDED_LEADING_GAP),
      [{ lineNumber: FILE_LINES + 500, side: 'additions' }]
    )
    expect([...rendered]).toEqual([])
  })
})

describe('renderedLinesSignature', () => {
  it('is stable across map and set ordering, so a repaint is not a change', () => {
    const one = new Map([
      ['b.ts', new Set([renderedLineKey('additions', 2)])],
      ['a.ts', new Set(['additions:9', 'additions:1'])],
    ])
    const other = new Map([
      ['a.ts', new Set(['additions:1', 'additions:9'])],
      ['b.ts', new Set(['additions:2'])],
    ])
    expect(renderedLinesSignature(one)).toBe(renderedLinesSignature(other))
  })

  it('changes when a line is revealed', () => {
    const before = new Map([['a.ts', new Set<string>()]])
    const after = new Map([['a.ts', new Set(['additions:5'])]])
    expect(renderedLinesSignature(before)).not.toBe(
      renderedLinesSignature(after)
    )
  })
})
