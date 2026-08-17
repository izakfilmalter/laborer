/**
 * The manual project order shared by the sidebar tree and the kanban lanes.
 *
 * @see apps/web/src/atoms/project-order.ts
 */

import { describe, expect, it } from 'vitest'
import {
  compareProjects,
  planProjectMove,
  planProjectNudge,
  sortProjectsByRank,
} from '../../src/atoms/project-order'

/** An unranked project falls back to createdAt, so ids are ordered by it. */
const project = (
  id: string,
  createdAt: number,
  sortOrder: number | null = null
) => ({
  createdAt,
  id,
  sortOrder,
})

/** Ranks a plan promises, applied over the rows it was planned against. */
const orderAfter = (
  rows: readonly ReturnType<typeof project>[],
  plan: readonly { readonly projectId: string; readonly sortOrder: number }[]
): readonly string[] => {
  const ranks = new Map(plan.map((one) => [one.projectId, one.sortOrder]))
  const applied = rows.map((one) => {
    const sortOrder = ranks.get(one.id)
    return sortOrder === undefined ? one : { ...one, sortOrder }
  })
  return sortProjectsByRank(applied).map(({ id }) => id)
}

describe('compareProjects', () => {
  it('falls back to createdAt for an unranked project', () => {
    expect(
      sortProjectsByRank([
        project('b', 200),
        project('a', 100),
        project('c', 300),
      ]).map(({ id }) => id)
    ).toEqual(['a', 'b', 'c'])
  })

  it('lets a rank override the creation order', () => {
    expect(
      sortProjectsByRank([
        project('a', 100),
        project('b', 200),
        project('c', 50),
      ]).map(({ id }) => id)
    ).toEqual(['c', 'a', 'b'])
  })

  it('breaks ties on id, the way the server does', () => {
    expect(compareProjects(project('a', 100), project('b', 100))).toBe(-1)
    expect(compareProjects(project('b', 100), project('a', 100))).toBe(1)
    expect(compareProjects(project('a', 100), project('a', 100))).toBe(0)
  })

  it('leaves a list of fewer than two projects untouched', () => {
    const rows = [project('a', 100)]
    expect(sortProjectsByRank(rows)).toBe(rows)
  })
})

describe('planProjectMove', () => {
  const rows = [project('a', 100), project('b', 200), project('c', 300)]

  it('lands a project dragged down after its target', () => {
    const plan = planProjectMove(rows, 'a', 'c')
    expect(plan).toHaveLength(1)
    expect(orderAfter(rows, plan)).toEqual(['b', 'c', 'a'])
  })

  it('lands a project dragged up before its target', () => {
    const plan = planProjectMove(rows, 'c', 'a')
    expect(plan).toHaveLength(1)
    expect(orderAfter(rows, plan)).toEqual(['c', 'a', 'b'])
  })

  it('ranks only the project that moved', () => {
    expect(
      planProjectMove(rows, 'c', 'a').map(({ projectId }) => projectId)
    ).toEqual(['c'])
  })

  it('reorders the full list even when the tree is filtered', () => {
    // Only "a" and "d" are on screen; the hidden projects keep their places.
    const filtered = [...rows, project('d', 400)]
    const plan = planProjectMove(filtered, 'd', 'a')
    expect(orderAfter(filtered, plan)).toEqual(['d', 'a', 'b', 'c'])
  })

  it('has nothing to commit for a drop onto itself or an unknown id', () => {
    expect(planProjectMove(rows, 'a', 'a')).toEqual([])
    expect(planProjectMove(rows, 'a', 'ghost')).toEqual([])
    expect(planProjectMove(rows, 'ghost', 'a')).toEqual([])
  })

  it('spaces the whole list out when the neighbours it lands between tie', () => {
    // "a" and "b" were created in the same millisecond, so a midpoint between
    // them does not exist and a single-row write could not place "c".
    const tied = [project('a', 100), project('b', 100), project('c', 300)]
    const plan = planProjectMove(tied, 'c', 'b')
    expect(plan).toHaveLength(3)
    expect(orderAfter(tied, plan)).toEqual(['a', 'c', 'b'])
  })
})

describe('planProjectNudge', () => {
  const rows = [project('a', 100), project('b', 200), project('c', 300)]

  it('moves a project one slot at a time', () => {
    expect(orderAfter(rows, planProjectNudge(rows, 'b', -1))).toEqual([
      'b',
      'a',
      'c',
    ])
    expect(orderAfter(rows, planProjectNudge(rows, 'b', 1))).toEqual([
      'a',
      'c',
      'b',
    ])
  })

  it('stops at either end of the list', () => {
    expect(planProjectNudge(rows, 'a', -1)).toEqual([])
    expect(planProjectNudge(rows, 'c', 1)).toEqual([])
    expect(planProjectNudge(rows, 'ghost', 1)).toEqual([])
  })
})
