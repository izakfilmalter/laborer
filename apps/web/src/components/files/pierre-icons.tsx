/**
 * Pierre file-icon resolution shared by the file explorer and the right
 * panel's file tabs.
 *
 * Ported from t3code's `pierre-icons.ts` + `PierreEntryIcon`, minus t3's
 * branded sprite additions: Laborer uses `@pierre/trees`' built-in
 * "complete" set unmodified. The sprite sheet is injected once into the
 * document body so `<use href="#...">` references resolve outside the
 * tree's shadow root (the tabs render icons in the light DOM).
 */

import { cn } from '@laborer/ui/lib/utils'
import type { FileTreeIcons } from '@pierre/trees'
import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
} from '@pierre/trees'
import { FileIcon, FolderIcon } from 'lucide-react'
import { memo, useInsertionEffect, useMemo } from 'react'

export interface PierreIconResolution {
  name: string
  token?: string
}

const PIERRE_ICON_SPRITE_ID = 'laborer-pierre-file-icon-sprite'

export const LABORER_PIERRE_ICONS = {
  set: 'complete',
  colored: true,
} satisfies FileTreeIcons

const completeIconResolver = createFileTreeIconResolver(LABORER_PIERRE_ICONS)

export function resolvePierreIconForEntry(
  pathValue: string,
  kind: 'file' | 'directory'
): PierreIconResolution | null {
  if (kind === 'directory') {
    return null
  }
  return completeIconResolver.resolveIcon('file-tree-icon-file', pathValue)
}

export function ensurePierreIconSprite(): void {
  if (
    typeof document === 'undefined' ||
    document.getElementById(PIERRE_ICON_SPRITE_ID)
  ) {
    return
  }
  const container = document.createElement('div')
  container.id = PIERRE_ICON_SPRITE_ID
  container.setAttribute('aria-hidden', 'true')
  container.style.position = 'absolute'
  container.style.width = '0'
  container.style.height = '0'
  container.style.overflow = 'hidden'
  container.style.pointerEvents = 'none'
  container.innerHTML = getBuiltInSpriteSheet('complete')
  document.body.prepend(container)
}

/** Per-token icon tints, verbatim from t3code's `PierreEntryIcon`. */
const ICON_COLORS: Record<string, readonly [light: string, dark: string]> = {
  astro: ['#a631be', '#d568ea'],
  babel: ['#d5a910', '#ffd452'],
  bash: ['#199f43', '#5ecc71'],
  biome: ['#1a85d4', '#69b1ff'],
  bootstrap: ['#693acf', '#9d6afb'],
  browserslist: ['#d5a910', '#ffd452'],
  bun: ['#594c5b', '#79697b'],
  c: ['#1a85d4', '#69b1ff'],
  claude: ['#d47628', '#ffa359'],
  cpp: ['#1a85d4', '#69b1ff'],
  css: ['#693acf', '#9d6afb'],
  database: ['#a631be', '#d568ea'],
  default: ['#84848a', '#adadb1'],
  docker: ['#1a85d4', '#69b1ff'],
  eslint: ['#693acf', '#9d6afb'],
  git: ['#ff8c5b', '#d5512f'],
  go: ['#1ca1c7', '#68cdf2'],
  graphql: ['#d32a61', '#ff678d'],
  html: ['#d47628', '#ffa359'],
  image: ['#d32a61', '#ff678d'],
  javascript: ['#d5a910', '#ffd452'],
  json: ['#d47628', '#ffa359'],
  markdown: ['#199f43', '#5ecc71'],
  mcp: ['#17a5af', '#64d1db'],
  nextjs: ['#84848a', '#adadb1'],
  npm: ['#d52c36', '#ff6762'],
  oxc: ['#1ca1c7', '#68cdf2'],
  postcss: ['#d52c36', '#ff6762'],
  prettier: ['#17a5af', '#64d1db'],
  python: ['#1a85d4', '#69b1ff'],
  react: ['#1ca1c7', '#68cdf2'],
  ruby: ['#d52c36', '#ff6762'],
  rust: ['#d47628', '#ffa359'],
  sass: ['#d32a61', '#ff678d'],
  stylelint: ['#84848a', '#adadb1'],
  svelte: ['#d52c36', '#ff6762'],
  svg: ['#d47628', '#ffa359'],
  svgo: ['#199f43', '#5ecc71'],
  swift: ['#d47628', '#ffa359'],
  table: ['#17a5af', '#64d1db'],
  tailwind: ['#1ca1c7', '#68cdf2'],
  terraform: ['#693acf', '#9d6afb'],
  text: ['#84848a', '#adadb1'],
  typescript: ['#1a85d4', '#69b1ff'],
  vite: ['#a631be', '#d568ea'],
  vscode: ['#1a85d4', '#69b1ff'],
  vue: ['#199f43', '#5ecc71'],
  wasm: ['#693acf', '#9d6afb'],
  webpack: ['#1a85d4', '#69b1ff'],
  yml: ['#d52c36', '#ff6762'],
  zig: ['#d47628', '#ffa359'],
  zip: ['#d47628', '#ffa359'],
}

export const PierreEntryIcon = memo(function PierreEntryIcon(props: {
  pathValue: string
  kind: 'file' | 'directory'
  theme: 'light' | 'dark'
  className?: string
}) {
  useInsertionEffect(ensurePierreIconSprite, [])
  const icon = useMemo(
    () => resolvePierreIconForEntry(props.pathValue, props.kind),
    [props.kind, props.pathValue]
  )

  if (!icon) {
    return props.kind === 'directory' ? (
      <FolderIcon
        className={cn('size-4 text-muted-foreground', props.className)}
      />
    ) : (
      <FileIcon
        className={cn('size-4 text-muted-foreground', props.className)}
      />
    )
  }

  const colors = ICON_COLORS[icon.token ?? 'default'] ?? ICON_COLORS.default
  return (
    <svg
      aria-hidden="true"
      className={cn('size-4 shrink-0', props.className)}
      data-icon-token={icon.token}
      data-pierre-icon={icon.name}
      style={{ color: colors?.[props.theme === 'light' ? 0 : 1] }}
      viewBox="0 0 16 16"
    >
      <use href={`#${icon.name}`} />
    </svg>
  )
})
