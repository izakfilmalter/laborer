/** Creates a promise that never resolves — simulates a hanging request. */
export function pendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => {
    // Intentionally never resolved
  })
}

/** Replace globalThis.fetch with a simple URL-based mock. */
export function mockFetch(
  impl: (url: string) => Promise<{ ok: boolean } | never>
) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    return impl(url) as Promise<Response>
  }) as typeof fetch
}
