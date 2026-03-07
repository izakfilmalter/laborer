/**
 * Ring buffer unit tests.
 *
 * Tests the ring buffer data structure in isolation per PRD-terminal-perf.md
 * "Ring Buffer Unit Tests" section and Issue #138 acceptance criteria.
 *
 * Test categories:
 * - Basic write/read operations
 * - Wrap-around behavior
 * - Edge cases (exact capacity, zero bytes, empty buffer)
 * - Sequential operations
 * - Clear/reset
 * - String convenience method
 */

import { describe, expect, it } from 'vitest'
import { RingBuffer } from '../src/lib/ring-buffer.js'

const encoder = new TextEncoder()

/** Helper: encode a string to UTF-8 bytes */
function encode(str: string): Uint8Array {
  return encoder.encode(str)
}

/** Helper: decode bytes to string */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

describe('RingBuffer', () => {
  describe('constructor', () => {
    it('creates a buffer with the specified capacity', () => {
      const buf = new RingBuffer(1024)
      expect(buf.maxCapacity).toBe(1024)
      expect(buf.size).toBe(0)
    })

    it('creates a buffer with default 1MB capacity', () => {
      const buf = new RingBuffer()
      expect(buf.maxCapacity).toBe(1_048_576)
      expect(buf.size).toBe(0)
    })

    it('throws on zero capacity', () => {
      expect(() => new RingBuffer(0)).toThrow('capacity must be positive')
    })

    it('throws on negative capacity', () => {
      expect(() => new RingBuffer(-1)).toThrow('capacity must be positive')
    })
  })

  describe('write less than capacity', () => {
    it('stores and returns the written data', () => {
      const buf = new RingBuffer(64)
      const data = encode('hello')
      buf.write(data)
      expect(decode(buf.read())).toBe('hello')
    })

    it('reports correct size', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello'))
      expect(buf.size).toBe(5)
    })

    it('handles multiple writes that fit in capacity', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello '))
      buf.write(encode('world'))
      expect(decode(buf.read())).toBe('hello world')
      expect(buf.size).toBe(11)
    })
  })

  describe('write more than capacity (wrap-around)', () => {
    it('returns only the last capacity bytes', () => {
      const buf = new RingBuffer(5)
      // Write 10 bytes into a 5-byte buffer
      buf.write(encode('0123456789'))
      expect(decode(buf.read())).toBe('56789')
      expect(buf.size).toBe(5)
    })

    it('wraps correctly with multiple sequential writes', () => {
      const buf = new RingBuffer(10)
      buf.write(encode('abcdefgh')) // 8 bytes, no wrap yet
      expect(buf.size).toBe(8)
      buf.write(encode('ijkl')) // 4 more bytes, total 12, wraps
      // Buffer should contain the last 10 bytes: "cdefghijkl"
      expect(decode(buf.read())).toBe('cdefghijkl')
      expect(buf.size).toBe(10)
    })

    it('handles wrap with data exactly double the capacity', () => {
      const buf = new RingBuffer(5)
      buf.write(encode('abcde')) // fills exactly
      buf.write(encode('fghij')) // overwrites completely
      expect(decode(buf.read())).toBe('fghij')
      expect(buf.size).toBe(5)
    })

    it('handles single write much larger than capacity', () => {
      const buf = new RingBuffer(3)
      buf.write(encode('abcdefghij')) // 10 bytes into 3-byte buffer
      expect(decode(buf.read())).toBe('hij')
      expect(buf.size).toBe(3)
    })
  })

  describe('write exactly capacity', () => {
    it('returns all data when writing exactly capacity bytes at once', () => {
      const buf = new RingBuffer(5)
      buf.write(encode('abcde'))
      expect(decode(buf.read())).toBe('abcde')
      expect(buf.size).toBe(5)
    })

    it('returns all data when filling to capacity with multiple writes', () => {
      const buf = new RingBuffer(6)
      buf.write(encode('abc'))
      buf.write(encode('def'))
      expect(decode(buf.read())).toBe('abcdef')
      expect(buf.size).toBe(6)
    })
  })

  describe('write zero bytes', () => {
    it('is a no-op on empty buffer', () => {
      const buf = new RingBuffer(64)
      buf.write(new Uint8Array(0))
      expect(buf.size).toBe(0)
      expect(buf.read().length).toBe(0)
    })

    it('is a no-op on buffer with existing data', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello'))
      buf.write(new Uint8Array(0))
      expect(decode(buf.read())).toBe('hello')
      expect(buf.size).toBe(5)
    })
  })

  describe('read from empty buffer', () => {
    it('returns empty Uint8Array', () => {
      const buf = new RingBuffer(64)
      const result = buf.read()
      expect(result.length).toBe(0)
      expect(result).toBeInstanceOf(Uint8Array)
    })
  })

  describe('read returns a copy', () => {
    it('modifying the returned array does not affect the buffer', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello'))
      const result = buf.read()
      result[0] = 0 // Mutate the returned copy
      expect(decode(buf.read())).toBe('hello') // Original unchanged
    })
  })

  describe('sequential writes and reads', () => {
    it('produces correct results across many operations', () => {
      const buf = new RingBuffer(10)

      // Write "abc" (3 bytes, size=3)
      buf.write(encode('abc'))
      expect(decode(buf.read())).toBe('abc')
      expect(buf.size).toBe(3)

      // Write "defg" (4 bytes, size=7)
      buf.write(encode('defg'))
      expect(decode(buf.read())).toBe('abcdefg')
      expect(buf.size).toBe(7)

      // Write "hijk" (4 bytes, size=10, fills to capacity then wraps by 1)
      buf.write(encode('hijk'))
      expect(decode(buf.read())).toBe('bcdefghijk')
      expect(buf.size).toBe(10)

      // Write "lm" (2 bytes, wraps further)
      buf.write(encode('lm'))
      expect(decode(buf.read())).toBe('defghijklm')
      expect(buf.size).toBe(10)
    })

    it('handles alternating small writes correctly', () => {
      const buf = new RingBuffer(5)
      for (let i = 0; i < 10; i++) {
        buf.write(encode(String(i)))
      }
      // Last 5 characters: "56789"
      expect(decode(buf.read())).toBe('56789')
      expect(buf.size).toBe(5)
    })
  })

  describe('clear', () => {
    it('resets size to 0', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello'))
      buf.clear()
      expect(buf.size).toBe(0)
    })

    it('read returns empty after clear', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello'))
      buf.clear()
      expect(buf.read().length).toBe(0)
    })

    it('allows writing after clear', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello'))
      buf.clear()
      buf.write(encode('world'))
      expect(decode(buf.read())).toBe('world')
      expect(buf.size).toBe(5)
    })

    it('works after wrap-around', () => {
      const buf = new RingBuffer(5)
      buf.write(encode('abcdefgh')) // wraps
      buf.clear()
      expect(buf.size).toBe(0)
      expect(buf.read().length).toBe(0)
      buf.write(encode('xy'))
      expect(decode(buf.read())).toBe('xy')
    })
  })

  describe('readString', () => {
    it('returns empty string for empty buffer', () => {
      const buf = new RingBuffer(64)
      expect(buf.readString()).toBe('')
    })

    it('returns UTF-8 string for buffer content', () => {
      const buf = new RingBuffer(64)
      buf.write(encode('hello world'))
      expect(buf.readString()).toBe('hello world')
    })

    it('handles Unicode characters', () => {
      const buf = new RingBuffer(256)
      const text = 'Hello 🌍 — émojis & ünïcödë'
      buf.write(encode(text))
      expect(buf.readString()).toBe(text)
    })

    it('returns correct string after wrap-around', () => {
      const buf = new RingBuffer(10)
      buf.write(encode('abcdefghijklmno')) // 15 bytes into 10
      expect(buf.readString()).toBe('fghijklmno')
    })
  })

  describe('binary data', () => {
    it('handles raw bytes including null bytes', () => {
      const buf = new RingBuffer(10)
      const data = new Uint8Array([0, 1, 2, 3, 0, 255, 254, 253])
      buf.write(data)
      const result = buf.read()
      expect(result.length).toBe(8)
      expect(Array.from(result)).toEqual([0, 1, 2, 3, 0, 255, 254, 253])
    })

    it('handles ANSI escape sequences (terminal output)', () => {
      const buf = new RingBuffer(256)
      // Typical ANSI: ESC[31m (red text) + "error" + ESC[0m (reset)
      const ansi = '\x1b[31merror\x1b[0m'
      buf.write(encode(ansi))
      expect(buf.readString()).toBe(ansi)
    })
  })

  describe('capacity of 1', () => {
    it('stores only the last byte', () => {
      const buf = new RingBuffer(1)
      buf.write(encode('abc'))
      expect(decode(buf.read())).toBe('c')
      expect(buf.size).toBe(1)
    })

    it('handles single byte writes', () => {
      const buf = new RingBuffer(1)
      buf.write(encode('a'))
      expect(decode(buf.read())).toBe('a')
      buf.write(encode('b'))
      expect(decode(buf.read())).toBe('b')
      expect(buf.size).toBe(1)
    })
  })

  describe('stress test', () => {
    it('handles many small writes without corruption', () => {
      const buf = new RingBuffer(100)
      // Write 1000 single-digit numbers
      for (let i = 0; i < 1000; i++) {
        buf.write(encode(String(i % 10)))
      }
      const result = buf.readString()
      expect(result.length).toBe(100)
      expect(buf.size).toBe(100)
      // Verify the last 100 characters are the digits 0-9 repeated
      // Last 1000 writes: digits 0,1,...,9,0,1,...,9 repeating
      // Last 100 of these: starts at index 900 (900 % 10 = 0)
      for (let i = 0; i < 100; i++) {
        expect(result[i]).toBe(String((900 + i) % 10))
      }
    })
  })
})
