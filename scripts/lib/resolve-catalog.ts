/**
 * Resolve `catalog:` dependency specs using the workspace catalog.
 *
 * Pure function: returns a new record with every `catalog:…` value replaced by
 * the concrete version string found in `catalog`. Throws on missing entries.
 *
 * Also filters out `workspace:*` dependencies (internal packages that are
 * bundled by tsdown and don't need to be installed at runtime).
 */
export function resolveCatalogDependencies(
  dependencies: Record<string, unknown>,
  catalog: Record<string, unknown>,
  label: string
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(dependencies)
      // Filter out workspace dependencies — these are internal packages
      // that get bundled into the service output by tsdown's `noExternal`.
      .filter(([, spec]) => {
        if (typeof spec === 'string' && spec.startsWith('workspace:')) {
          return false
        }
        return true
      })
      .map(([name, spec]) => {
        if (typeof spec !== 'string' || !spec.startsWith('catalog:')) {
          return [name, spec]
        }

        const catalogKey = spec.slice('catalog:'.length).trim()
        const lookupKey = catalogKey.length > 0 ? catalogKey : name
        const resolved = catalog[lookupKey]

        if (typeof resolved !== 'string' || resolved.length === 0) {
          throw new Error(
            `Unable to resolve '${spec}' for ${label} dependency '${name}'. ` +
              `Expected key '${lookupKey}' in root workspace catalog.`
          )
        }

        return [name, resolved]
      })
  )
}
