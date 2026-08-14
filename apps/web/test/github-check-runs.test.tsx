import type { PullRequestCheckRun } from '@laborer/shared/rpc'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  formatDuration,
  GitHubCheckRunsSummary,
  summarize,
} from '@/components/github-check-runs'

const check = (
  bucket: PullRequestCheckRun['bucket'],
  name: string
): PullRequestCheckRun => ({
  bucket,
  durationMs: null,
  group: null,
  name,
  url: null,
})

describe('check run summary', () => {
  it('leads with the buckets worth acting on', () => {
    expect(
      summarize([
        check('success', 'Build'),
        check('skipped', 'Codesmith'),
        check('failure', 'Unit Tests'),
        check('success', 'Lint'),
        check('cancelled', 'E2E'),
      ])
    ).toBe('1 failed · 2 passed · 1 canceled · 1 skipped')
  })

  it('names only the buckets that occurred', () => {
    expect(summarize([check('success', 'Build')])).toBe('1 passed')
  })
})

describe('check run duration', () => {
  it.each([
    [40_000, '40s'],
    [179_000, '2m 59s'],
    [916_000, '15m 16s'],
    [3_900_000, '1h 5m'],
  ])('reads %ims as %s', (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected)
  })

  it('says nothing about a check that took no time', () => {
    expect(formatDuration(200)).toBeNull()
  })
})

const BUILD_RE = /Build/

describe('check run summary card', () => {
  afterEach(() => {
    cleanup()
  })

  it('explains a red rollup workflow by workflow', () => {
    render(
      <GitHubCheckRunsSummary
        checkStatus="failure"
        checks={[
          {
            bucket: 'cancelled',
            durationMs: 916_000,
            group: 'E2E Tests',
            name: 'E2E Tests',
            url: null,
          },
          {
            bucket: 'success',
            durationMs: 40_000,
            group: 'Merge Checks',
            name: 'Build',
            url: 'https://github.com/org/repo/runs/1',
          },
          {
            bucket: 'failure',
            durationMs: 179_000,
            group: 'Merge Checks',
            name: 'Unit Tests',
            url: null,
          },
        ]}
      />
    )

    expect(screen.getByText('Some checks were not successful')).toBeTruthy()
    expect(screen.getByText('1 failed · 1 passed · 1 canceled')).toBeTruthy()
    // Workflows are real structure, so they head the list they contain.
    expect(screen.getByText('Merge Checks')).toBeTruthy()
    expect(screen.getByText('2m 59s')).toBeTruthy()
    // A run with somewhere to go is the way to go there.
    expect(
      screen.getByRole('link', { name: BUILD_RE }).getAttribute('href')
    ).toBe('https://github.com/org/repo/runs/1')
  })

  it('leaves a single workflow unnamed', () => {
    const { container } = render(
      <GitHubCheckRunsSummary
        checkStatus="success"
        checks={[
          {
            bucket: 'success',
            durationMs: null,
            group: 'Merge Checks',
            name: 'Build',
            url: null,
          },
        ]}
      />
    )

    expect(screen.getByText('All checks passed')).toBeTruthy()
    expect(screen.queryByText('Merge Checks')).toBeNull()
    expect(within(container).getByText('Build')).toBeTruthy()
  })
})
