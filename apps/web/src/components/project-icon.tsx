/**
 * A project's glyph: the favicon discovered in its repository, or an
 * accent-coloured repository mark when it ships none.
 *
 * One component for every surface that names a project, so the sidebar and
 * the workspace header answer "which project is this?" with the same mark at
 * the same size.
 */

import { cn } from '@laborer/ui/lib/utils'
import { FolderGit2 } from 'lucide-react'
import { useState } from 'react'
import { projectAccent } from '@/lib/project-accent'

interface ProjectIconProps {
  readonly className?: string
  readonly project: {
    readonly color?: string | null | undefined
    readonly iconDataUrl?: string | null | undefined
    readonly name: string
  }
}

function ProjectIcon({ className, project }: ProjectIconProps) {
  const iconDataUrl = project.iconDataUrl ?? null
  // A stored icon can still fail to decode — a truncated or mislabelled file
  // reaches us as a valid data URL. Remembering which URL failed, rather than
  // a bare flag, lets a re-discovered icon try again without an effect to
  // reset it, and keeps the row's layout intact instead of leaving a gap.
  const [failedIconDataUrl, setFailedIconDataUrl] = useState<string | null>(
    null
  )

  if (iconDataUrl !== null && iconDataUrl !== failedIconDataUrl) {
    return (
      // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError is a load-failure signal, not user interaction.
      <img
        alt=""
        className={cn(
          'size-3.5 shrink-0 rounded-[2px] object-contain',
          className
        )}
        height={14}
        onError={() => {
          setFailedIconDataUrl(iconDataUrl)
        }}
        src={iconDataUrl}
        width={14}
      />
    )
  }

  return (
    <FolderGit2
      className={cn(
        'size-3.5 shrink-0',
        projectAccent(project).iconClassName,
        className
      )}
    />
  )
}

export { ProjectIcon }
