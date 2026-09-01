/// <reference types="vite/client" />

/**
 * `vite/client` declares `?url`, `?raw`, and `?inline` on their own, but not the
 * combined `?url&no-inline` query the Ghostty runtime uses to guarantee the
 * write-PTY trampoline is fetched as a real URL rather than inlined as a data
 * URL (`WebAssembly.instantiateStreaming` needs a fetchable URL).
 */
declare module '*?url&no-inline' {
  const src: string
  export default src
}
