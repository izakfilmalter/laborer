/**
 * Shared command palette chrome, ported from t3code: one input, one
 * results panel, and a keyboard-hint footer.
 */

import { Kbd, KbdGroup } from '@laborer/ui/components/kbd'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { Command, CommandFooter, CommandInput, CommandPanel } from './command'

type CommandPaletteContentProps = Omit<
  ComponentProps<typeof Command>,
  'children'
> & {
  readonly children: ReactNode
  readonly inputProps: ComponentProps<typeof CommandInput>
  readonly showBackHint?: boolean
}

export function CommandPaletteContent({
  children,
  inputProps,
  showBackHint = false,
  ...commandProps
}: CommandPaletteContentProps) {
  return (
    <Command {...commandProps}>
      <CommandInput {...inputProps} />
      <CommandPanel className="max-h-[min(28rem,70vh)]">
        {children}
      </CommandPanel>
      <CommandFooter>
        <div className="flex items-center gap-3">
          <KbdGroup className="items-center gap-1.5">
            <Kbd>
              <ArrowUpIcon />
            </Kbd>
            <Kbd>
              <ArrowDownIcon />
            </Kbd>
            <span>Navigate</span>
          </KbdGroup>
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Enter</Kbd>
            <span>Select</span>
          </KbdGroup>
          {showBackHint && (
            <KbdGroup className="items-center gap-1.5">
              <Kbd>Backspace</Kbd>
              <span>Back</span>
            </KbdGroup>
          )}
          <KbdGroup className="items-center gap-1.5">
            <Kbd>Esc</Kbd>
            <span>Close</span>
          </KbdGroup>
        </div>
      </CommandFooter>
    </Command>
  )
}
