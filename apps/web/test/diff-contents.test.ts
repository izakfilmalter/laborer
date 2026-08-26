import { DiffContentsUnavailable } from '@laborer/shared/rpc'
import type { FileDiffMetadata } from '@pierre/diffs'
import { describe, expect, it } from 'vitest'
import {
  describeDiffContentsFailure,
  diffContentsCacheKey,
  diffContentsPayload,
  toLoadedDiffFiles,
  truncatedSideMessage,
} from '@/lib/diff-contents'
import { buildPatchCacheKey } from '@/lib/file-diff'

const fileDiff = (
  overrides: Partial<FileDiffMetadata> = {}
): FileDiffMetadata =>
  ({
    additionLines: [],
    deletionLines: [],
    hunks: [],
    isPartial: true,
    name: 'src/example.ts',
    splitLineCount: 0,
    type: 'change',
    unifiedLineCount: 0,
    ...overrides,
  }) as FileDiffMetadata

describe('diffContentsPayload', () => {
  it('sends the same path on both sides for an unrenamed change', () => {
    expect(
      diffContentsPayload(fileDiff(), {
        target: { _tag: 'working' },
        workspaceId: 'workspace-one',
      })
    ).toEqual({
      changeType: 'change',
      newPath: 'src/example.ts',
      oldPath: 'src/example.ts',
      target: { _tag: 'working' },
      workspaceId: 'workspace-one',
    })
  })

  it('reads the old path off the rename', () => {
    expect(
      diffContentsPayload(
        fileDiff({
          name: 'src/renamed.ts',
          prevName: 'src/original.ts',
          type: 'rename-changed',
        }),
        { target: { _tag: 'branch' }, workspaceId: 'workspace-one' }
      )
    ).toMatchObject({
      changeType: 'rename-changed',
      newPath: 'src/renamed.ts',
      oldPath: 'src/original.ts',
    })
  })

  it('carries the target the patch was cut under, not a default', () => {
    // The old side only means anything relative to the same target; sending
    // `working` for a branch diff serves a different revision's file.
    expect(
      diffContentsPayload(fileDiff(), {
        target: { _tag: 'ref', ref: 'origin/main' },
        workspaceId: 'workspace-one',
      })
    ).toMatchObject({ target: { _tag: 'ref', ref: 'origin/main' } })
  })

  it.each([
    'new',
    'deleted',
  ] as const)('asks for nothing on a %s file, which the RPC schema refuses anyway', (type) => {
    // Both already carry the whole of the side that exists, so there is no
    // unchanged context to expand into.
    expect(
      diffContentsPayload(fileDiff({ type }), {
        target: { _tag: 'working' },
        workspaceId: 'workspace-one',
      })
    ).toBeNull()
  })
})

describe('diffContentsCacheKey', () => {
  const patch = [
    'diff --git a/src/example.ts b/src/example.ts',
    '@@ -1,1 +1,1 @@',
    '-one',
    '+two',
    '',
  ].join('\n')

  it('hits when the watcher re-delivers a file that did not change', () => {
    // The pane refetches the whole workspace diff on every relevant watcher
    // event, which is most of them; an identical patch must not re-fetch.
    expect(diffContentsCacheKey('req', buildPatchCacheKey(patch))).toBe(
      diffContentsCacheKey('req', buildPatchCacheKey(patch))
    )
  })

  it('misses once the patch content changes', () => {
    expect(diffContentsCacheKey('req', buildPatchCacheKey(patch))).not.toBe(
      diffContentsCacheKey('req', buildPatchCacheKey(`${patch}+three\n`))
    )
  })

  it('misses when the question changes, because the old side moves with it', () => {
    const patchKey = buildPatchCacheKey(patch)
    expect(diffContentsCacheKey('working', patchKey)).not.toBe(
      diffContentsCacheKey('branch', patchKey)
    )
  })
})

describe('describeDiffContentsFailure', () => {
  const unavailable = (reason: DiffContentsUnavailable['reason']) =>
    describeDiffContentsFailure(
      new DiffContentsUnavailable({
        message: 'server sentence',
        path: 'src/example.ts',
        reason,
      })
    )

  it('says a binary file has no lines to show', () => {
    expect(unavailable('BINARY_FILE')).toBe(
      'src/example.ts is not a text file, so there are no surrounding lines to show.'
    )
  })

  it('distinguishes the missing side, because they mean different things', () => {
    expect(unavailable('OLD_PATH_ABSENT')).not.toBe(
      unavailable('NEW_PATH_ABSENT')
    )
    expect(unavailable('NEW_PATH_ABSENT')).toContain(
      'no longer in the worktree'
    )
    expect(unavailable('OLD_PATH_ABSENT')).toContain(
      'revision this diff compares against'
    )
  })

  it('reads a plain wire-shaped refusal too', () => {
    // Whatever squashed the cause need not hand back the class instance.
    expect(
      describeDiffContentsFailure({
        _tag: 'DiffContentsUnavailable',
        message: 'server sentence',
        path: 'assets/logo.png',
        reason: 'BINARY_FILE',
      })
    ).toContain('assets/logo.png')
  })

  it('says what the reader lost when the failure is not a refusal', () => {
    for (const error of [
      new Error('socket closed'),
      { _tag: 'RpcError', code: 'TIMEOUT', message: 'timed out' },
      null,
      undefined,
    ]) {
      expect(describeDiffContentsFailure(error)).toContain(
        'unchanged lines around this change stay hidden'
      )
    }
  })

  it('refuses a reason it does not recognise rather than printing it', () => {
    expect(
      describeDiffContentsFailure({
        _tag: 'DiffContentsUnavailable',
        message: 'm',
        path: 'p',
        reason: 'SOMETHING_NEW',
      })
    ).toContain('Could not load the rest of this file')
  })
})

describe('truncatedSideMessage', () => {
  it('stays quiet when both sides arrived whole', () => {
    expect(
      truncatedSideMessage(
        { newTruncated: false, oldTruncated: false },
        'src/example.ts'
      )
    ).toBeNull()
  })

  it.each([
    ['old', { newTruncated: false, oldTruncated: true }],
    ['new', { newTruncated: true, oldTruncated: false }],
    ['both', { newTruncated: true, oldTruncated: true }],
  ])('declines to hydrate when the %s side was cut off', (_label, flags) => {
    // A truncated side has fewer lines than the file, so hydrating from it
    // would drop the tail of every expansion with nothing on screen saying so.
    expect(truncatedSideMessage(flags, 'src/example.ts')).toContain(
      'too large to load in full'
    )
  })
})

describe('toLoadedDiffFiles', () => {
  const payload = {
    changeType: 'change' as const,
    newPath: 'src/example.ts',
    oldPath: 'src/example.ts',
    target: { _tag: 'working' as const },
    workspaceId: 'workspace-one',
  }
  const contents = { newContents: 'new\n', oldContents: 'old\n' }

  it('hands the viewer both sides for a content change', () => {
    const loaded = toLoadedDiffFiles(payload, contents, 'key')
    expect(loaded.oldFile).toMatchObject({
      contents: 'old\n',
      name: 'src/example.ts',
    })
    expect(loaded.newFile.contents).toBe('new\n')
  })

  it('gives a pure rename a null old side, which is what hydration insists on', () => {
    // `hydrateTwoSidedFileDiff` throws without an old side for a change, and
    // `hydratePartialDiff` throws *with* one for a pure rename.
    expect(
      toLoadedDiffFiles(
        {
          ...payload,
          changeType: 'rename-pure',
          newPath: 'src/renamed.ts',
          oldPath: 'src/original.ts',
        },
        contents,
        'key'
      ).oldFile
    ).toBeNull()
  })

  it('keys both sides off the fetch, so highlights turn over with the patch', () => {
    const first = toLoadedDiffFiles(payload, contents, 'key-one')
    const second = toLoadedDiffFiles(payload, contents, 'key-two')
    expect(first.newFile.cacheKey).not.toBe(second.newFile.cacheKey)
    expect(first.oldFile?.cacheKey).not.toBe(first.newFile.cacheKey)
  })
})
