import type { LabelColor } from './rpc.js'

/**
 * The durable label palette, in the order the deterministic derivation indexes
 * into. Persistence, RPC, and the renderer share this one tuple so a label
 * created without an explicit color looks the same everywhere.
 */
export const LABEL_COLORS = [
  'red',
  'orange',
  'amber',
  'emerald',
  'teal',
  'blue',
  'violet',
  'pink',
] as const satisfies readonly LabelColor[]

const HASH_MULTIPLIER = 31

/**
 * Derives a stable palette token from a label name. Pure and total: the same
 * name always yields the same color on the server and in the renderer, so an
 * optimistic chip never recolors when the stored row arrives.
 */
export const labelColorForName = (name: string): LabelColor => {
  const normalized = name.trim().toLowerCase()
  let hash = 0
  for (const character of normalized) {
    hash = Math.trunc(hash * HASH_MULTIPLIER + (character.codePointAt(0) ?? 0))
    // Fold into a 32-bit range so long names stay in safe-integer territory.
    hash %= 2 ** 31
  }
  const index = Math.abs(hash) % LABEL_COLORS.length
  return LABEL_COLORS[index] ?? LABEL_COLORS[0]
}
