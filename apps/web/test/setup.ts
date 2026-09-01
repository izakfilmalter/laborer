/**
 * jsdom has no canvas implementation, so `getContext` throws a "not
 * implemented" error into the virtual console for every call. The Ghostty font
 * probe treats an unmeasurable environment as "assume monospace"; returning
 * null states that contract explicitly instead of relying on the thrown error,
 * and keeps the test output readable.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
    writable: true,
  })
}

/**
 * jsdom implements neither the Web Animations API nor `Element.getAnimations`,
 * which Base UI's scroll area calls when it settles a scroll. Without it every
 * rendered `ScrollArea` throws asynchronously and poisons unrelated tests.
 */
if (typeof Element !== 'undefined' && !('getAnimations' in Element.prototype)) {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
    writable: true,
  })
}
