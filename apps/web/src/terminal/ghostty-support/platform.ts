/** biome-ignore-all lint/performance/useTopLevelRegex: vendored from t3code (github.com/pingdotgg/t3code); keep verbatim so the tree can be re-synced */

/**
 * Platform predicates the vendored Ghostty surface depends on.
 *
 * Lifted verbatim from t3code's `apps/web/src/lib/utils.ts` so the vendored
 * `ghostty/` tree keeps its upstream shape without dragging in that module's
 * unrelated dependencies.
 */

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform)
}
