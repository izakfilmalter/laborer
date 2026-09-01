import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The terminal pane renders through a vendored Ghostty WASM runtime, which
 * fetches its `.wasm` modules and Nerd Font fallback face at runtime from the
 * daemon's static asset route. Vite content-hashes those filenames, so the
 * exact names cannot be pinned; each group is matched by pattern instead and
 * every group must resolve to at least one emitted file.
 *
 * Without these, the packaged app boots to a terminal that never instantiates
 * its emulator, and the packaged renderer smoke test still passes because the
 * failure is confined to `fetch` inside the pane.
 */
export const REQUIRED_TERMINAL_ASSET_GROUPS = [
  { label: 'Ghostty VT runtime', pattern: /^assets\/ghostty-vt-[^/]+\.wasm$/ },
  {
    label: 'Ghostty PTY writer',
    pattern: /^assets\/ghostty-write-pty-[^/]+\.wasm$/,
  },
  {
    label: 'Nerd Font symbol fallback',
    pattern: /^assets\/SymbolsNerdFontMono-Regular-[^/]+\.woff2$/,
  },
] as const

/**
 * List every file under `root` as a slash-separated path relative to it.
 */
function listFilesRecursively(root: string): readonly string[] {
  const files: string[] = []
  const pending = ['']
  while (pending.length > 0) {
    const directory = pending.pop()
    if (directory === undefined) {
      continue
    }
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        pending.push(path)
      } else {
        files.push(path)
      }
    }
  }
  return files
}

/**
 * Resolve the content-hashed Ghostty WASM and font assets the terminal pane
 * fetches at runtime, failing when the bundle no longer emits one of them.
 *
 * Returns their paths relative to the client directory so the packaged-asar
 * check can assert the same files survived into `app.asar`.
 */
export function resolveBundledTerminalAssets(
  clientDir: string
): readonly string[] {
  const files = listFilesRecursively(clientDir)
  const resolved: string[] = []
  const missing: string[] = []

  for (const group of REQUIRED_TERMINAL_ASSET_GROUPS) {
    const matches = files.filter((file) => group.pattern.test(file))
    if (matches.length === 0) {
      missing.push(`${group.label} (${String(group.pattern)})`)
      continue
    }
    resolved.push(...matches)
  }

  if (missing.length > 0) {
    throw new Error(
      `Bundled client is missing terminal runtime assets: ${missing.join(', ')}. ` +
        'The packaged terminal cannot instantiate its emulator without them.'
    )
  }

  // Vite inlines small assets as data URLs and emits no file for them, so a
  // zero-byte file here means the bundle would fetch an empty module.
  const empty = resolved.filter(
    (file) => statSync(join(clientDir, file)).size === 0
  )
  if (empty.length > 0) {
    throw new Error(
      `Bundled terminal runtime assets are empty: ${empty.join(', ')}`
    )
  }

  return resolved.toSorted()
}
