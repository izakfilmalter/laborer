import { describe, expect, it } from 'vitest'
import {
  defaultProjectShortName,
  formatTaskIdentifier,
  isProjectShortName,
  normalizeProjectShortName,
  parseTaskIdentifier,
} from '../src/task-identifier.js'

describe('task identifiers', () => {
  it('normalizes and validates project short names', () => {
    expect(normalizeProjectShortName(' Church work! ')).toBe('CHURCHWORK')
    expect(defaultProjectShortName('Laborer')).toBe('LABORER')
    expect(isProjectShortName('LAB')).toBe(true)
    expect(isProjectShortName('1LAB')).toBe(false)
  })

  it('formats and case-insensitively parses readable identifiers', () => {
    expect(formatTaskIdentifier('LAB', 42)).toBe('LAB-42')
    expect(parseTaskIdentifier(' lab-42 ')).toEqual({
      projectShortName: 'LAB',
      taskNumber: 42,
    })
    expect(parseTaskIdentifier('LAB-0')).toBeNull()
  })
})
