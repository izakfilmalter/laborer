// biome-ignore-all lint/style/useFilenamingConvention: preserves the upstream t3code module name.
/**
 * Canonical Electron `<webview webpreferences>` string from t3code.
 *
 * `main.ts` force-applies these flags and the approved preload again in
 * `will-attach-webview`; this string is only the renderer's declarative copy.
 */
export const PREVIEW_WEBVIEW_PREFERENCES =
  'contextIsolation=true,sandbox=true,nodeIntegration=false,nodeIntegrationInSubFrames=false,nodeIntegrationInWorker=false,webSecurity=true,allowRunningInsecureContent=false,experimentalFeatures=false,webviewTag=false'
