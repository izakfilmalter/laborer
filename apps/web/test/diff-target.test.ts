import type { DiffTarget } from '@laborer/shared/rpc'
import { describe, expect, it } from 'vitest'
import {
  asDiffTargetFailure,
  DEFAULT_DIFF_TARGET,
  describeDiffTargetFailure,
  diffTargetChoices,
  diffTargetKey,
  diffTargetLabel,
  fileDiffPayload,
  fileDiffRequestKey,
  parseDiffTargetKey,
  parseFileDiffRequestKey,
} from '@/lib/diff-target'

const TARGETS: readonly DiffTarget[] = [
  { _tag: 'working' },
  { _tag: 'branch' },
  { _tag: 'ref', ref: 'origin/main' },
  { _tag: 'ref', ref: 'release/2026-01-05' },
]

describe('diff target keys', () => {
  it('round-trips every target it can name', () => {
    for (const target of TARGETS) {
      expect(parseDiffTargetKey(diffTargetKey(target))).toEqual(target)
    }
  })

  it('refuses keys it did not write', () => {
    expect(parseDiffTargetKey('')).toBeNull()
    expect(parseDiffTargetKey('ref:')).toBeNull()
    expect(parseDiffTargetKey('staged')).toBeNull()
    expect(parseDiffTargetKey('{"_tag":"branch"}')).toBeNull()
  })

  it('keeps a ref containing a colon intact', () => {
    const target: DiffTarget = { _tag: 'ref', ref: 'refs/tags/v1:rc' }
    expect(parseDiffTargetKey(diffTargetKey(target))).toEqual(target)
  })
})

describe('diff target choices', () => {
  it('offers the working tree first, so the default is the first item', () => {
    const [first] = diffTargetChoices(DEFAULT_DIFF_TARGET)
    expect(first?.target).toEqual(DEFAULT_DIFF_TARGET)
  })

  it('always contains the current selection, including a typed ref', () => {
    const typed: DiffTarget = { _tag: 'ref', ref: 'upstream/trunk' }
    const keys = diffTargetChoices(typed).map((choice) => choice.key)
    expect(keys).toContain(diffTargetKey(typed))
  })

  it('does not duplicate a typed ref that is already suggested', () => {
    const keys = diffTargetChoices({ _tag: 'ref', ref: 'origin/main' }).map(
      (choice) => choice.key
    )
    expect(keys.filter((key) => key === 'ref:origin/main')).toHaveLength(1)
  })

  it('gives every choice a distinct key and a non-empty description', () => {
    const choices = diffTargetChoices({ _tag: 'branch' })
    expect(new Set(choices.map((choice) => choice.key)).size).toBe(
      choices.length
    )
    for (const choice of choices) {
      expect(choice.description.length).toBeGreaterThan(0)
      expect(choice.label.length).toBeGreaterThan(0)
    }
  })

  it('names each target distinctly', () => {
    const labels = TARGETS.map(diffTargetLabel)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('file.diff request shape', () => {
  it('sends the working tree target and no whitespace flag by default', () => {
    expect(
      fileDiffPayload({
        ignoreWhitespace: false,
        target: DEFAULT_DIFF_TARGET,
        workspaceId: 'ws-1',
      })
    ).toEqual({
      ignoreWhitespace: false,
      target: { _tag: 'working' },
      workspaceId: 'ws-1',
    })
  })

  it('carries the branch target and the whitespace flag through', () => {
    expect(
      fileDiffPayload({
        ignoreWhitespace: true,
        target: { _tag: 'branch' },
        workspaceId: 'ws-1',
      })
    ).toEqual({
      ignoreWhitespace: true,
      target: { _tag: 'branch' },
      workspaceId: 'ws-1',
    })
  })

  it('carries an explicit ref through verbatim', () => {
    expect(
      fileDiffPayload({
        ignoreWhitespace: false,
        target: { _tag: 'ref', ref: 'origin/main' },
        workspaceId: 'ws-1',
      }).target
    ).toEqual({ _tag: 'ref', ref: 'origin/main' })
  })
})

describe('file.diff request keys', () => {
  it('round-trips every combination the toolbar can produce', () => {
    for (const target of TARGETS) {
      for (const ignoreWhitespace of [false, true]) {
        const request = { ignoreWhitespace, target, workspaceId: 'ws-1' }
        expect(parseFileDiffRequestKey(fileDiffRequestKey(request))).toEqual(
          request
        )
      }
    }
  })

  it('separates the three questions the pane can ask about one workspace', () => {
    const working = fileDiffRequestKey({
      ignoreWhitespace: false,
      target: { _tag: 'working' },
      workspaceId: 'ws-1',
    })
    const branch = fileDiffRequestKey({
      ignoreWhitespace: false,
      target: { _tag: 'branch' },
      workspaceId: 'ws-1',
    })
    const branchNoWhitespace = fileDiffRequestKey({
      ignoreWhitespace: true,
      target: { _tag: 'branch' },
      workspaceId: 'ws-1',
    })

    expect(new Set([working, branch, branchNoWhitespace]).size).toBe(3)
  })

  it('keeps two workspaces on the same target apart', () => {
    const request = { ignoreWhitespace: false, target: { _tag: 'branch' } }
    expect(fileDiffRequestKey({ ...request, workspaceId: 'ws-1' })).not.toBe(
      fileDiffRequestKey({ ...request, workspaceId: 'ws-2' })
    )
  })

  it('refuses a key it did not write', () => {
    expect(parseFileDiffRequestKey('')).toBeNull()
    expect(parseFileDiffRequestKey('ws-1')).toBeNull()
    expect(parseFileDiffRequestKey('w\u0000branch')).toBeNull()
    expect(parseFileDiffRequestKey('w\u0000staged\u0000ws-1')).toBeNull()
  })
})

describe('recognising an unresolvable target', () => {
  it('picks DiffTargetUnresolved out of a squashed failure', () => {
    expect(
      asDiffTargetFailure({
        _tag: 'DiffTargetUnresolved',
        message: 'This repository has no ref named origin/main.',
        reason: 'REF_NOT_FOUND',
        ref: 'origin/main',
      })
    ).toEqual({
      message: 'This repository has no ref named origin/main.',
      reason: 'REF_NOT_FOUND',
      ref: 'origin/main',
    })
  })

  it('accepts the null ref a missing base branch carries', () => {
    expect(
      asDiffTargetFailure({
        _tag: 'DiffTargetUnresolved',
        message: 'No base branch is recorded for this workspace.',
        reason: 'NO_BASE_BRANCH',
        ref: null,
      })?.ref
    ).toBeNull()
  })

  it('leaves every other failure to the generic banner', () => {
    expect(asDiffTargetFailure(null)).toBeNull()
    expect(asDiffTargetFailure('boom')).toBeNull()
    expect(
      asDiffTargetFailure({ _tag: 'RpcError', code: 'TIMEOUT', message: 'x' })
    ).toBeNull()
    expect(
      asDiffTargetFailure({
        _tag: 'DiffTargetUnresolved',
        message: 'x',
        reason: 'SOMETHING_ELSE',
        ref: null,
      })
    ).toBeNull()
  })
})

describe('what each unresolved reason tells the user to do', () => {
  it('sends a workspace with no base branch to an explicit ref', () => {
    const copy = describeDiffTargetFailure({
      message: 'server sentence',
      reason: 'NO_BASE_BRANCH',
      ref: null,
    })
    expect(copy.title).toBe('No base branch to compare against')
    expect(copy.guidance.toLowerCase()).toContain('name a base ref')
    expect(copy.guidance.toLowerCase()).toContain('uncommitted changes')
  })

  it('names the missing ref and says to fetch it', () => {
    const copy = describeDiffTargetFailure({
      message: 'server sentence',
      reason: 'REF_NOT_FOUND',
      ref: 'origin/main',
    })
    // The server's own message names the ref right under this heading, so
    // the heading stays categorical instead of repeating it.
    expect(copy.title).toBe('No such ref in this repository')
    expect(copy.guidance.toLowerCase()).toContain('fetch origin/main')
  })

  it('explains unrelated histories rather than reporting a git failure', () => {
    const copy = describeDiffTargetFailure({
      message: 'server sentence',
      reason: 'MERGE_BASE_FAILED',
      ref: 'origin/legacy',
    })
    expect(copy.title).toBe('No shared history to fork from')
    expect(copy.guidance.toLowerCase()).toContain('origin/legacy')
    expect(copy.guidance.toLowerCase()).toContain('no common ancestor')
    expect(copy.guidance.toLowerCase()).toContain('same history')
  })

  it('still reads as a sentence when the ref is unknown', () => {
    for (const reason of ['REF_NOT_FOUND', 'MERGE_BASE_FAILED'] as const) {
      const copy = describeDiffTargetFailure({
        message: '',
        reason,
        ref: null,
      })
      expect(copy.title).not.toContain('null')
      expect(copy.guidance).not.toContain('null')
      expect(copy.guidance).toContain('that ref')
    }
  })
})
