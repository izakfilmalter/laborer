// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module name.
/**
 * Canonical Electron `<webview webpreferences>` string from t3code.
 *
 * The picker preload intentionally shares the page world so it can inspect
 * React metadata. The renderer remains OS-sandboxed and has no Node access.
 * `main.ts` force-applies these flags again in `will-attach-webview`.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  'contextIsolation=false,sandbox=true,nodeIntegration=false'
