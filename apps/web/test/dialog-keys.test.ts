/**
 * Unit tests for confirmation dialog keyboard event helpers.
 *
 * These test the pure functions that control keyboard behavior in
 * destructive confirmation dialogs (delete workspace, close terminal).
 * Plain Enter is blocked to prevent accidental confirmation; Cmd+Enter
 * is required to confirm the destructive action.
 *
 * @see apps/web/src/lib/dialog-keys.ts
 */

import { describe, expect, it } from 'vitest'
import { isExactEnter, isMetaEnter } from '../src/lib/dialog-keys'

// ---------------------------------------------------------------------------
// Helper — create a minimal KeyboardEvent-shaped object for testing.
// Uses the subset of properties our functions actually check.
// ---------------------------------------------------------------------------

function makeKeyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent
}

// ---------------------------------------------------------------------------
// Tests: isExactEnter (plain Enter with no modifiers — should be blocked)
// ---------------------------------------------------------------------------

describe('isExactEnter', () => {
  it('returns true for plain Enter', () => {
    expect(isExactEnter(makeKeyEvent({ key: 'Enter' }))).toBe(true)
  })

  it('returns false when meta is held (Cmd+Enter)', () => {
    expect(isExactEnter(makeKeyEvent({ key: 'Enter', metaKey: true }))).toBe(
      false
    )
  })

  it('returns false when ctrl is held', () => {
    expect(isExactEnter(makeKeyEvent({ key: 'Enter', ctrlKey: true }))).toBe(
      false
    )
  })

  it('returns false when shift is held', () => {
    expect(isExactEnter(makeKeyEvent({ key: 'Enter', shiftKey: true }))).toBe(
      false
    )
  })

  it('returns false when alt is held', () => {
    expect(isExactEnter(makeKeyEvent({ key: 'Enter', altKey: true }))).toBe(
      false
    )
  })

  it('returns false for a different key', () => {
    expect(isExactEnter(makeKeyEvent({ key: 'Escape' }))).toBe(false)
  })

  it('returns false for space key', () => {
    expect(isExactEnter(makeKeyEvent({ key: ' ' }))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tests: isMetaEnter (Cmd+Enter — confirms the destructive action)
// ---------------------------------------------------------------------------

describe('isMetaEnter', () => {
  it('returns true for Cmd+Enter', () => {
    expect(isMetaEnter(makeKeyEvent({ key: 'Enter', metaKey: true }))).toBe(
      true
    )
  })

  it('returns false for plain Enter', () => {
    expect(isMetaEnter(makeKeyEvent({ key: 'Enter' }))).toBe(false)
  })

  it('returns false when shift is also held', () => {
    expect(
      isMetaEnter(makeKeyEvent({ key: 'Enter', metaKey: true, shiftKey: true }))
    ).toBe(false)
  })

  it('returns false when alt is also held', () => {
    expect(
      isMetaEnter(makeKeyEvent({ key: 'Enter', metaKey: true, altKey: true }))
    ).toBe(false)
  })

  it('returns false when ctrl is also held', () => {
    expect(
      isMetaEnter(makeKeyEvent({ key: 'Enter', metaKey: true, ctrlKey: true }))
    ).toBe(false)
  })

  it('returns false for Ctrl+Enter (not Cmd)', () => {
    expect(isMetaEnter(makeKeyEvent({ key: 'Enter', ctrlKey: true }))).toBe(
      false
    )
  })

  it('returns false for a different key with meta', () => {
    expect(isMetaEnter(makeKeyEvent({ key: 'a', metaKey: true }))).toBe(false)
  })
})
