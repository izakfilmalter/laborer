/**
 * Shared ID generation for panel layout nodes.
 *
 * Centralizes the counter + random suffix pattern used across panel-tab-utils,
 * window-tab-utils, workspace-tile-utils, and layout-migration. A bug fix or
 * strategy change now only needs to happen in one place.
 */

let _counter = 0

/**
 * Generate a unique ID with the given prefix.
 * Uses an incrementing counter with a random suffix to avoid collisions.
 *
 * @param prefix - A short string identifying the node type (e.g., "panel-tab", "window-tab")
 * @returns A unique string ID like "panel-tab-1-a3f2c1"
 */
function generateId(prefix: string): string {
  _counter += 1
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${_counter}-${random}`
}

export { generateId }
