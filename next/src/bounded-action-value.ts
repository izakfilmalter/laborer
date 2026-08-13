export const ACTION_CANONICAL_MAX_DEPTH = 8
export const ACTION_CANONICAL_MAX_ITEMS = 256
export const ACTION_CANONICAL_MAX_BYTES = 64 * 1024

export const canonicalCatalogJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCatalogJson).join(',')}]`
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalCatalogJson(item)}`
    )
    .join(',')}}`
}

const INVALID_CANONICAL_VALUE = Symbol('invalid-canonical-value')

interface CanonicalValueBudget {
  remainingItems: number
}

function normalizeCanonicalArray(
  value: readonly unknown[],
  depth: number,
  budget: CanonicalValueBudget
): unknown | typeof INVALID_CANONICAL_VALUE {
  if (
    value.length > ACTION_CANONICAL_MAX_ITEMS ||
    value.length > budget.remainingItems
  ) {
    return INVALID_CANONICAL_VALUE
  }
  budget.remainingItems -= value.length
  const normalized: unknown[] = []
  for (const item of value) {
    const candidate = normalizeCanonicalValue(item, depth + 1, budget)
    if (candidate === INVALID_CANONICAL_VALUE) {
      return INVALID_CANONICAL_VALUE
    }
    normalized.push(candidate)
  }
  return normalized
}

function normalizeCanonicalObject(
  value: object,
  depth: number,
  budget: CanonicalValueBudget
): unknown | typeof INVALID_CANONICAL_VALUE {
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  if (
    entries.length > ACTION_CANONICAL_MAX_ITEMS ||
    entries.length > budget.remainingItems
  ) {
    return INVALID_CANONICAL_VALUE
  }
  budget.remainingItems -= entries.length
  const normalized = Object.create(null) as Record<string, unknown>
  const normalizedKeys = new Set<string>()
  for (const [key, item] of entries) {
    const normalizedKey = key.normalize('NFC')
    if (normalizedKeys.has(normalizedKey)) {
      return INVALID_CANONICAL_VALUE
    }
    normalizedKeys.add(normalizedKey)
    const candidate = normalizeCanonicalValue(item, depth + 1, budget)
    if (candidate === INVALID_CANONICAL_VALUE) {
      return INVALID_CANONICAL_VALUE
    }
    normalized[normalizedKey] = candidate
  }
  return normalized
}

function normalizeCanonicalValue(
  value: unknown,
  depth: number,
  budget: CanonicalValueBudget
): unknown | typeof INVALID_CANONICAL_VALUE {
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value.normalize('NFC')
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : INVALID_CANONICAL_VALUE
  }
  if (depth >= ACTION_CANONICAL_MAX_DEPTH) {
    return INVALID_CANONICAL_VALUE
  }
  if (Array.isArray(value)) {
    return normalizeCanonicalArray(value, depth, budget)
  }
  if (typeof value !== 'object') {
    return INVALID_CANONICAL_VALUE
  }
  return normalizeCanonicalObject(value, depth, budget)
}

export const canonicalBoundedActionValue = (value: unknown): string => {
  const normalized = normalizeCanonicalValue(value, 0, {
    remainingItems: ACTION_CANONICAL_MAX_ITEMS,
  })
  if (normalized === INVALID_CANONICAL_VALUE) {
    throw new Error('invalid canonical Action value')
  }
  const json = canonicalCatalogJson(normalized)
  if (Buffer.byteLength(json, 'utf8') > ACTION_CANONICAL_MAX_BYTES) {
    throw new Error('canonical Action value is oversized')
  }
  return json
}
