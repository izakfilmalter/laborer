import { createHash } from 'node:crypto'

/**
 * Maximum length for a DNS label per RFC 1035.
 * Container names must fit within this limit since OrbStack uses them
 * as DNS labels in `.orb.local` domains.
 */
const DNS_LABEL_MAX_LENGTH = 63

/**
 * Length of the hash suffix appended when a name must be truncated.
 * 6 hex characters = 16^6 ≈ 16.7 million unique values.
 */
const HASH_SUFFIX_LENGTH = 6

/** Matches trailing hyphens for cleanup after truncation. */
const TRAILING_HYPHENS = /-+$/

/**
 * Sanitize a raw string into a DNS-safe slug.
 *
 * Steps:
 * 1. Lowercase
 * 2. Replace slashes with hyphens
 * 3. Strip characters outside `[a-z0-9-]`
 * 4. Collapse consecutive hyphens
 * 5. Trim leading/trailing hyphens
 */
const sanitizeSlug = (raw: string): string =>
  raw
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')

/**
 * Produce a short SHA-256 hash of the original (unsanitized) inputs.
 * This preserves uniqueness when truncation would otherwise create collisions.
 */
const shortHash = (branchName: string, projectName: string): string =>
  createHash('sha256')
    .update(`${branchName}--${projectName}`)
    .digest('hex')
    .slice(0, HASH_SUFFIX_LENGTH)

/**
 * Convert a `(branchName, projectName)` pair into a DNS-safe Docker
 * container name and its corresponding `.orb.local` URL.
 *
 * The container name follows the pattern `{branchSlug}--{projectSlug}`.
 * OrbStack automatically provides a domain at `{containerName}.orb.local`.
 *
 * @example
 * ```ts
 * containerName('feature/auth', 'my-project')
 * // => { name: 'feature-auth--my-project', url: 'feature-auth--my-project.orb.local' }
 * ```
 */
export const containerName = (
  branchName: string,
  projectName: string
): { name: string; url: string } => {
  const branchSlug = sanitizeSlug(branchName)
  const projectSlug = sanitizeSlug(projectName)

  // Build the full candidate name
  const candidate = `${branchSlug}--${projectSlug}`

  let name: string

  if (candidate.length <= DNS_LABEL_MAX_LENGTH) {
    name = candidate
  } else {
    // Truncate and append a hash suffix for uniqueness.
    // Reserve space for `-` separator + hash suffix.
    const maxBaseLength = DNS_LABEL_MAX_LENGTH - 1 - HASH_SUFFIX_LENGTH
    const hash = shortHash(branchName, projectName)
    const truncated = candidate
      .slice(0, maxBaseLength)
      .replace(TRAILING_HYPHENS, '')
    name = `${truncated}-${hash}`
  }

  return { name, url: `${name}.orb.local` }
}
