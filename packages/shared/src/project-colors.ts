import type { ProjectColor } from './rpc.js'

/**
 * The durable project accent palette, in the order the deterministic
 * derivation indexes into.
 *
 * Every token is a mid-chroma hue that stays legible as a thin border and as
 * a low-alpha wash on the dark surface, so a project accent never fights the
 * agent-status colours it shares the workspace header with.
 */
export const PROJECT_COLORS = [
  'blue',
  'cyan',
  'teal',
  'emerald',
  'lime',
  'amber',
  'orange',
  'rose',
  'pink',
  'fuchsia',
  'violet',
  'indigo',
] as const satisfies readonly ProjectColor[]

const HASH_MULTIPLIER = 31

/**
 * Derives a stable palette token from a project name. Pure and total: the
 * same name always yields the same accent on the server and in the renderer,
 * so an optimistically added project never recolors when its stored row
 * arrives.
 */
export const projectColorForName = (name: string): ProjectColor => {
  const normalized = name.trim().toLowerCase()
  let hash = 0
  for (const character of normalized) {
    hash = Math.trunc(hash * HASH_MULTIPLIER + (character.codePointAt(0) ?? 0))
    // Fold into a 32-bit range so long names stay in safe-integer territory.
    hash %= 2 ** 31
  }
  const index = Math.abs(hash) % PROJECT_COLORS.length
  return PROJECT_COLORS[index] ?? PROJECT_COLORS[0]
}

/**
 * Picks the accent for a newly registered project: the first palette token no
 * sibling has taken, falling back to the name-derived color once the palette
 * is exhausted. Distinguishing projects at a glance is the whole point, so
 * spreading across the palette beats a pure hash while there is room.
 */
export const nextProjectColor = (
  name: string,
  taken: readonly (string | null)[]
): ProjectColor => {
  const used = new Set(taken.filter((color): color is string => color !== null))
  return (
    PROJECT_COLORS.find((color) => !used.has(color)) ??
    projectColorForName(name)
  )
}
