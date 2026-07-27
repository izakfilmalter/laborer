export const ACTION_CANONICAL_MAX_DEPTH = 8;
export const ACTION_CANONICAL_MAX_ITEMS = 256;
export const ACTION_CANONICAL_MAX_BYTES = 64 * 1024;

export const canonicalCatalogJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCatalogJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) => `${JSON.stringify(key)}:${canonicalCatalogJson(item)}`
    )
    .join(",")}}`;
};

const INVALID_CANONICAL_VALUE = Symbol("invalid-canonical-value");

const normalizeCanonicalValue = (
  value: unknown,
  depth: number
): unknown | typeof INVALID_CANONICAL_VALUE => {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.normalize("NFC");
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_CANONICAL_VALUE;
  }
  if (depth >= ACTION_CANONICAL_MAX_DEPTH) {
    return INVALID_CANONICAL_VALUE;
  }
  if (Array.isArray(value)) {
    if (value.length > ACTION_CANONICAL_MAX_ITEMS) {
      return INVALID_CANONICAL_VALUE;
    }
    const normalized: unknown[] = [];
    for (const item of value) {
      const candidate = normalizeCanonicalValue(item, depth + 1);
      if (candidate === INVALID_CANONICAL_VALUE) {
        return INVALID_CANONICAL_VALUE;
      }
      normalized.push(candidate);
    }
    return normalized;
  }
  if (typeof value !== "object") {
    return INVALID_CANONICAL_VALUE;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  if (entries.length > ACTION_CANONICAL_MAX_ITEMS) {
    return INVALID_CANONICAL_VALUE;
  }
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of entries) {
    const candidate = normalizeCanonicalValue(item, depth + 1);
    if (candidate === INVALID_CANONICAL_VALUE) {
      return INVALID_CANONICAL_VALUE;
    }
    normalized[key.normalize("NFC")] = candidate;
  }
  return normalized;
};

export const canonicalBoundedActionValue = (value: unknown): string => {
  const normalized = normalizeCanonicalValue(value, 0);
  if (normalized === INVALID_CANONICAL_VALUE) {
    throw new Error("invalid canonical Action value");
  }
  const json = canonicalCatalogJson(normalized);
  if (Buffer.byteLength(json, "utf8") > ACTION_CANONICAL_MAX_BYTES) {
    throw new Error("canonical Action value is oversized");
  }
  return json;
};
