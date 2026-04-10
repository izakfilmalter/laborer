/**
 * Tests for snapshot cache helpers — Issue 21
 *
 * Unit tests for pure functions that compute cache hashes and generate
 * Daytona snapshot names for dependency caching. These are pure string
 * and crypto operations with no external dependencies.
 */

import { createHash } from 'node:crypto'

import { describe, expect, it } from '@effect/vitest'

import {
  buildCacheHash,
  buildSnapshotName,
  MAX_SNAPSHOT_NAME_LENGTH,
  SNAPSHOT_NAME_PREFIX,
} from '../../server/src/lib/snapshot-cache.js'

const HEX_12_PATTERN = /^[\da-f]{12}$/u

describe('snapshot-cache helpers', () => {
  describe('buildCacheHash', () => {
    it('produces a 12-char hex string from lockfile hash alone', () => {
      const result = buildCacheHash('abc123def456')
      expect(result).toHaveLength(12)
      expect(result).toMatch(HEX_12_PATTERN)
    })

    it('includes base image in the hash when provided', () => {
      const hashWithoutImage = buildCacheHash('abc123def456')
      const hashWithImage = buildCacheHash('abc123def456', 'node:22')
      expect(hashWithoutImage).not.toBe(hashWithImage)
    })

    it('produces different hashes for different lockfile hashes', () => {
      const hash1 = buildCacheHash('abc123def456')
      const hash2 = buildCacheHash('xyz789uvw012')
      expect(hash1).not.toBe(hash2)
    })

    it('produces different hashes for different base images', () => {
      const hash1 = buildCacheHash('abc123def456', 'node:22')
      const hash2 = buildCacheHash('abc123def456', 'node:20')
      expect(hash1).not.toBe(hash2)
    })

    it('is deterministic — same inputs produce same output', () => {
      const hash1 = buildCacheHash('abc123def456', 'node:22')
      const hash2 = buildCacheHash('abc123def456', 'node:22')
      expect(hash1).toBe(hash2)
    })

    it('matches manual SHA-256 computation', () => {
      const lockfileHash = 'abc123def456'
      const expected = createHash('sha256')
        .update(lockfileHash)
        .digest('hex')
        .slice(0, 12)
      expect(buildCacheHash(lockfileHash)).toBe(expected)
    })

    it('matches manual SHA-256 computation with base image', () => {
      const lockfileHash = 'abc123def456'
      const baseImage = 'node:22'
      const expected = createHash('sha256')
        .update(`${lockfileHash}:${baseImage}`)
        .digest('hex')
        .slice(0, 12)
      expect(buildCacheHash(lockfileHash, baseImage)).toBe(expected)
    })
  })

  describe('buildSnapshotName', () => {
    it('produces the correct format: prefix-slug-hash', () => {
      const name = buildSnapshotName('my-project', 'abc123def456')
      expect(name).toBe(`${SNAPSHOT_NAME_PREFIX}-my-project-abc123def456`)
    })

    it('sanitizes project name with special characters', () => {
      const name = buildSnapshotName('My Project!@#', 'abc123def456')
      expect(name).toBe(`${SNAPSHOT_NAME_PREFIX}-my-project-abc123def456`)
    })

    it('lowercases the project name', () => {
      const name = buildSnapshotName('MyProject', 'abc123def456')
      expect(name).toBe(`${SNAPSHOT_NAME_PREFIX}-myproject-abc123def456`)
    })

    it('truncates to MAX_SNAPSHOT_NAME_LENGTH', () => {
      const longName = 'a'.repeat(100)
      const name = buildSnapshotName(longName, 'abc123def456')
      expect(name.length).toBeLessThanOrEqual(MAX_SNAPSHOT_NAME_LENGTH)
    })

    it('preserves short names without truncation', () => {
      const name = buildSnapshotName('app', 'abc123def456')
      expect(name).toBe(`${SNAPSHOT_NAME_PREFIX}-app-abc123def456`)
      expect(name.length).toBeLessThan(MAX_SNAPSHOT_NAME_LENGTH)
    })

    it('handles empty project name', () => {
      const name = buildSnapshotName('', 'abc123def456')
      expect(name).toBe(`${SNAPSHOT_NAME_PREFIX}--abc123def456`)
    })
  })

  describe('constants', () => {
    it('SNAPSHOT_NAME_PREFIX is laborer-deps', () => {
      expect(SNAPSHOT_NAME_PREFIX).toBe('laborer-deps')
    })

    it('MAX_SNAPSHOT_NAME_LENGTH is 63', () => {
      expect(MAX_SNAPSHOT_NAME_LENGTH).toBe(63)
    })
  })
})
