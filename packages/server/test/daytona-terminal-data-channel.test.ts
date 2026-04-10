/**
 * Tests for Daytona terminal data channel bridge (Issue #17).
 *
 * Verifies:
 * - Terminal ID prefix detection and stripping
 * - Client message parsing (ack vs raw input)
 */

import { describe, expect, it } from '@effect/vitest'

import {
  DAYTONA_TERMINAL_ID_PREFIX,
  isDaytonaTerminalId,
  parseClientMessage,
  stripDaytonaPrefix,
} from '../src/services/daytona-terminal-data-channel.js'

describe('Daytona terminal data channel', () => {
  describe('DAYTONA_TERMINAL_ID_PREFIX', () => {
    it('is "daytona:"', () => {
      expect(DAYTONA_TERMINAL_ID_PREFIX).toBe('daytona:')
    })
  })

  describe('isDaytonaTerminalId', () => {
    it('returns true for terminal IDs with daytona: prefix', () => {
      expect(isDaytonaTerminalId('daytona:abc-123')).toBe(true)
    })

    it('returns true for prefix-only string', () => {
      expect(isDaytonaTerminalId('daytona:')).toBe(true)
    })

    it('returns false for plain UUIDs', () => {
      expect(isDaytonaTerminalId('550e8400-e29b-41d4-a716-446655440000')).toBe(
        false
      )
    })

    it('returns false for empty string', () => {
      expect(isDaytonaTerminalId('')).toBe(false)
    })

    it('returns false for non-prefix daytona occurrence', () => {
      expect(isDaytonaTerminalId('not-daytona:abc')).toBe(false)
    })
  })

  describe('stripDaytonaPrefix', () => {
    it('strips the daytona: prefix from a terminal ID', () => {
      expect(stripDaytonaPrefix('daytona:abc-123')).toBe('abc-123')
    })

    it('returns empty string when only prefix is present', () => {
      expect(stripDaytonaPrefix('daytona:')).toBe('')
    })

    it('handles UUIDs correctly', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      expect(stripDaytonaPrefix(`daytona:${uuid}`)).toBe(uuid)
    })
  })

  describe('parseClientMessage', () => {
    it('parses a valid ack message', () => {
      const result = parseClientMessage('{"type":"ack","chars":5000}')
      expect(result).toEqual({ type: 'ack', chars: 5000 })
    })

    it('returns null for raw terminal input', () => {
      expect(parseClientMessage('hello')).toBeNull()
    })

    it('returns null for empty string', () => {
      expect(parseClientMessage('')).toBeNull()
    })

    it('returns null for non-ack JSON', () => {
      expect(
        parseClientMessage('{"type":"status","status":"running"}')
      ).toBeNull()
    })

    it('returns null for invalid JSON starting with {', () => {
      expect(parseClientMessage('{invalid json}')).toBeNull()
    })

    it('returns null for ack without chars field', () => {
      expect(parseClientMessage('{"type":"ack"}')).toBeNull()
    })

    it('returns null for ack with non-number chars', () => {
      expect(parseClientMessage('{"type":"ack","chars":"5000"}')).toBeNull()
    })
  })
})
