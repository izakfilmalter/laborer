/**
 * Module-level window resize listener.
 *
 * A single `window.resize` listener is registered once (on first import)
 * and shared across all subscribers. Components subscribe by calling
 * `subscribeWindowResize(callback)`, which returns an unsubscribe function.
 *
 * This lives outside of React's lifecycle so it is never torn down by
 * effect cleanup, component unmounts, or dependency changes. Terminal
 * panes use this to trigger re-fit operations on window resize without
 * tying the listener to the terminal's init/dispose cycle.
 */

type ResizeCallback = () => void

const subscribers = new Set<ResizeCallback>()

function onWindowResize() {
  for (const cb of subscribers) {
    cb()
  }
}

// Register exactly once at module level
window.addEventListener('resize', onWindowResize)

/**
 * Subscribe to window resize events.
 *
 * @returns An unsubscribe function. Call it to stop receiving callbacks.
 */
function subscribeWindowResize(callback: ResizeCallback): () => void {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}

export { subscribeWindowResize }
