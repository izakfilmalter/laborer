/**
 * A value that shows itself and hands itself over.
 *
 * Card titles are branch names, which are read far less often than they are
 * pasted into a terminal. The copy controls stay out of the layout until the
 * card is hovered, so the name keeps the full width it needs to be read.
 *
 * Its own module rather than the card's: the sidebar's workspace cards and the
 * pull requests that have not been pulled in yet both title themselves this
 * way, and neither should have to import the other to do it.
 */

import type { FC } from 'react'
import { CopyButton } from '@/components/copy-button'

interface CopyableValueProps {
  /** Label for the main copy button tooltip (e.g. "Copy branch name"). */
  readonly copyLabel: string
  /** Extra values that get their own copy button on hover. */
  readonly extraCopyValues?: ReadonlyArray<{
    readonly value: string
    readonly label: string
  }>
  readonly value: string
}

const CopyableValue: FC<CopyableValueProps> = (props) => {
  const { value, copyLabel, extraCopyValues } = props

  return (
    <span className="group/copyable flex w-full min-w-0 items-start justify-between gap-1">
      <span className="line-clamp-2 min-w-0 break-all">{value}</span>
      <span className="-mr-8 flex shrink-0 items-center gap-0.5 opacity-0 transition-all duration-200 group-hover/copyable:mr-0 group-hover/copyable:opacity-100">
        {extraCopyValues?.map((extra) => (
          <CopyButton
            aria-label={extra.label}
            key={extra.label}
            title={extra.label}
            value={extra.value}
          />
        ))}
        <CopyButton title={copyLabel} value={value} />
      </span>
    </span>
  )
}

export { CopyableValue }
