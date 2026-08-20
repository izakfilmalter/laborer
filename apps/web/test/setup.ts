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
