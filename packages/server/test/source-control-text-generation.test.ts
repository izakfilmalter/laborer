/**
 * Unit tests for the source control writer's prompts and parsing.
 *
 * The module is pure by design — context in, prompt out; model text in,
 * commit message out — so these tests pin the two things that decide whether
 * a generated commit is usable: that the operator's style preference actually
 * reaches the prompt, and that a sloppy model answer still yields something
 * git will accept.
 *
 * @see packages/server/src/services/source-control-text-generation.ts
 */

import type { SourceControlWritingSettings } from '@laborer/shared/source-control-writing'
import { describe, expect, it } from 'vitest'
import {
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  parseCommitMessage,
  parsePrContent,
  resolveWritingPolicy,
  sanitizeCommitSubject,
} from '../src/services/source-control-text-generation.js'

const settings = (
  overrides: Partial<SourceControlWritingSettings>
): SourceControlWritingSettings => ({
  customInstructions: '',
  followPrTemplate: true,
  model: 'openai/gpt-5.6-sol-fast',
  mode: 'repo_conventions',
  ...overrides,
})

describe('resolveWritingPolicy', () => {
  it('teaches the repository style by example', () => {
    const policy = resolveWritingPolicy(settings({}), [
      'Add sync status polling',
      'Fix worktree cleanup',
    ])

    expect(policy.commitInstructions).toContain('Add sync status polling')
    expect(policy.commitInstructions).toContain('Fix worktree cleanup')
  })

  it('asks for local style without inventing examples in a fresh repository', () => {
    const policy = resolveWritingPolicy(settings({}), [])

    expect(policy.commitInstructions).toContain('established writing style')
    expect(policy.commitInstructions).not.toContain('Recent commit subjects')
  })

  it('names Conventional Commits for the subject but not for the PR title', () => {
    const policy = resolveWritingPolicy(
      settings({ mode: 'conventional_commits' }),
      ['whatever the repo already does']
    )

    expect(policy.commitInstructions).toContain('Conventional Commits')
    expect(policy.prInstructions).toContain('Do not force')
    // The repository's own examples must not leak in and contradict the mode.
    expect(policy.commitInstructions).not.toContain('whatever the repo')
  })

  it('carries custom instructions into both surfaces', () => {
    const policy = resolveWritingPolicy(
      settings({
        customInstructions: 'Always mention the ticket',
        mode: 'custom',
      }),
      []
    )

    expect(policy.commitInstructions).toBe('Always mention the ticket')
    expect(policy.prInstructions).toBe('Always mention the ticket')
  })
})

describe('buildCommitMessagePrompt', () => {
  it('carries the style instructions and the staged diff', () => {
    const prompt = buildCommitMessagePrompt({
      branch: 'feature/sync',
      policy: {
        commitInstructions: 'Sound terse',
        prInstructions: 'unused here',
      },
      stagedPatch: '@@ -1 +1 @@\n-old\n+new',
      stagedSummary: 'M\tsrc/app.ts',
    })

    expect(prompt).toContain('Sound terse')
    expect(prompt).toContain('feature/sync')
    expect(prompt).toContain('M\tsrc/app.ts')
    expect(prompt).toContain('+new')
    // The PR-side instructions belong to the other prompt.
    expect(prompt).not.toContain('unused here')
  })

  it('names a detached HEAD rather than pretending there is a branch', () => {
    const prompt = buildCommitMessagePrompt({
      branch: null,
      policy: { commitInstructions: '', prInstructions: '' },
      stagedPatch: '',
      stagedSummary: '',
    })

    expect(prompt).toContain('(detached)')
  })
})

describe('buildPrContentPrompt', () => {
  const base = {
    baseBranch: 'main',
    commitSummary: 'abc123 Add polling',
    diffPatch: '@@ -1 +1 @@',
    diffSummary: '1 file changed',
    headBranch: 'feature/sync',
    policy: { commitInstructions: '', prInstructions: '' },
  }

  it('asks for its own headings when the repository has no template', () => {
    const prompt = buildPrContentPrompt({ ...base, prTemplate: null })

    expect(prompt).toContain('## Summary')
    expect(prompt).toContain('## Testing')
  })

  it('defers to the repository template when there is one', () => {
    const prompt = buildPrContentPrompt({
      ...base,
      prTemplate: '## Why\n<!-- explain -->',
    })

    expect(prompt).toContain('## Why')
    expect(prompt).toContain("repository's pull request template structure")
    // The default headings would fight the template's own structure.
    expect(prompt).not.toContain("headings '## Summary'")
  })
})

describe('parseCommitMessage', () => {
  it('reads a plain JSON answer', () => {
    expect(
      parseCommitMessage('{"subject":"Add polling","body":"- detail"}')
    ).toEqual({ body: '- detail', subject: 'Add polling' })
  })

  it('accepts the markdown fence a model wraps JSON in anyway', () => {
    expect(
      parseCommitMessage('```json\n{"subject":"Add polling","body":""}\n```')
    ).toEqual({ body: '', subject: 'Add polling' })
  })

  it('refuses an answer with no subject, so the caller can fall back', () => {
    expect(parseCommitMessage('sorry, I cannot help with that')).toBeNull()
    expect(parseCommitMessage('{"body":"just a body"}')).toBeNull()
  })
})

describe('sanitizeCommitSubject', () => {
  it('drops a trailing period and keeps the first line', () => {
    expect(sanitizeCommitSubject('Add polling.\n\nmore prose')).toBe(
      'Add polling'
    )
  })

  it('narrows an overlong subject instead of rejecting the commit', () => {
    const subject = sanitizeCommitSubject('x'.repeat(120))

    expect(subject).toHaveLength(72)
  })

  it('falls back rather than producing an empty subject', () => {
    expect(sanitizeCommitSubject('   ')).toBe('Update project files')
  })
})

describe('parsePrContent', () => {
  it('keeps the body markdown intact', () => {
    expect(
      parsePrContent('{"title":"Add polling","body":"## Summary\\n- one"}')
    ).toEqual({ body: '## Summary\n- one', title: 'Add polling' })
  })

  it('refuses an answer with no title', () => {
    expect(parsePrContent('{"body":"orphaned"}')).toBeNull()
  })
})
