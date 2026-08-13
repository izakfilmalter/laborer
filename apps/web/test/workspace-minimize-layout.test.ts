/**
 * Unit tests for the pure workspace minimize layout math.
 *
 * `distributeLayout` produces a full group layout where pinned panels
 * (minimized, or a panel being restored to a remembered size) keep an
 * exact percentage, and the remaining space is shared among the other
 * panels proportionally to their weights.
 */

import { describe, expect, it } from 'vitest'
import { distributeLayout } from '@/panels/workspace-minimize-layout'

describe('distributeLayout', () => {
  it('gives pinned panels their exact size and shares the rest proportionally', () => {
    const result = distributeLayout({
      weights: { b: 35, c: 25 },
      pinned: { a: 4 },
    })

    expect(result.a).toBe(4)
    expect(result.b).toBeCloseTo((35 / 60) * 96, 5)
    expect(result.c).toBeCloseTo((25 / 60) * 96, 5)
  })

  it('normalizes weights to 100 when nothing is pinned', () => {
    const result = distributeLayout({
      weights: { a: 40, b: 35, c: 25 },
      pinned: {},
    })

    expect(result.a).toBeCloseTo(40, 5)
    expect(result.b).toBeCloseTo(35, 5)
    expect(result.c).toBeCloseTo(25, 5)
  })

  it('splits remaining space equally when all weights are zero', () => {
    const result = distributeLayout({
      weights: { b: 0, c: 0 },
      pinned: { a: 10 },
    })

    expect(result.a).toBe(10)
    expect(result.b).toBeCloseTo(45, 5)
    expect(result.c).toBeCloseTo(45, 5)
  })

  it('prefers the pinned size when an id appears in both weights and pinned', () => {
    const result = distributeLayout({
      weights: { a: 40, b: 60 },
      pinned: { a: 4 },
    })

    expect(result.a).toBe(4)
    expect(result.b).toBeCloseTo(96, 5)
  })

  it('returns only pinned sizes when every panel is pinned', () => {
    const result = distributeLayout({
      weights: {},
      pinned: { a: 4, b: 4 },
    })

    expect(result).toEqual({ a: 4, b: 4 })
  })

  it('never distributes negative space when pinned sizes exceed 100', () => {
    const result = distributeLayout({
      weights: { c: 50 },
      pinned: { a: 60, b: 60 },
    })

    expect(result.c).toBe(0)
  })
})
