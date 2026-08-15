/**
 * Linear-style picker chrome layered on the shadcn combobox.
 *
 * The generic `ComboboxContent`/`ComboboxItem` pair anchors to a full-width
 * input; a picker instead hangs a compact popover off a small chip trigger and
 * shows a single trailing check rather than a leading one. These pieces are
 * the shared shape of every such picker, so a field only has to supply its
 * rows.
 */

'use client'

import { Combobox as ComboboxPrimitive } from '@base-ui/react'
import { CheckIcon } from 'lucide-react'
import type { ReactElement, ReactNode, RefObject } from 'react'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/utils'

/**
 * The portal, positioner, and bordered card every picker shares. Pass picker
 * contents (`PickerHeader`, `ComboboxEmpty`, `ComboboxList`) as children.
 */
export function PickerPopup({
  children,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  className,
  popupProps,
}: {
  readonly align?: ComboboxPrimitive.Positioner.Props['align']
  readonly children: ReactNode
  readonly className?: string
  readonly popupProps?: ComboboxPrimitive.Popup.Props
  readonly side?: ComboboxPrimitive.Positioner.Props['side']
  readonly sideOffset?: ComboboxPrimitive.Positioner.Props['sideOffset']
}): ReactElement {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner
        align={align}
        className="isolate z-50 select-none"
        data-slot="combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <ComboboxPrimitive.Popup
          className={cn(
            'data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 flex max-h-[min(var(--available-height),24rem)] min-w-56 max-w-(--available-width) origin-(--transform-origin) flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-closed:animate-out data-open:animate-in',
            className
          )}
          data-slot="combobox-popup"
          {...popupProps}
        >
          {children}
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

/**
 * The small kbd badge for a row's shortcut. Renders nothing when `shortcut` is
 * null so callers can map shortcuts uniformly.
 */
export function ShortcutHint({
  shortcut,
  className,
}: {
  readonly className?: string
  readonly shortcut: string | null
}): ReactElement | null {
  if (shortcut === null) {
    return null
  }
  return (
    <kbd
      className={cn(
        'flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-medium text-[0.625rem] text-muted-foreground',
        className
      )}
    >
      {shortcut}
    </kbd>
  )
}

/**
 * The filter input plus the field's open-shortcut hint. An invisible check
 * spacer mirrors the rows' check column, so the hint lines up with each row's
 * trailing shortcut.
 */
export function PickerHeader({
  placeholder,
  shortcut,
  inputProps,
}: {
  readonly inputProps?: ComboboxPrimitive.Input.Props
  readonly placeholder: string
  readonly shortcut?: string
}): ReactElement {
  return (
    <div className="mt-1 mb-1 flex items-center gap-2 border-b ps-1 pe-3 pb-1">
      <ComboboxPrimitive.Input
        className="h-8 min-w-0 flex-1 rounded-md border-0 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
        placeholder={placeholder}
        {...inputProps}
      />
      {shortcut === undefined ? null : (
        <span className="flex shrink-0 items-center gap-2">
          <CheckIcon aria-hidden className="invisible size-4" />
          <ShortcutHint shortcut={shortcut} />
        </span>
      )}
    </div>
  )
}

/**
 * A picker row: leading content (icon, dot, avatar), a trailing check on the
 * selected row, and an optional shortcut hint on the others.
 */
export function ComboboxOption({
  value,
  selected,
  shortcut = null,
  className,
  children,
  ...props
}: Omit<ComboboxPrimitive.Item.Props, 'value'> & {
  readonly selected: boolean
  readonly shortcut?: string | null
  readonly value: ComboboxPrimitive.Item.Props['value']
}): ReactElement {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-foreground text-sm outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-60 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      data-slot="combobox-option"
      value={value}
      {...props}
    >
      {children}
      <span className="ms-auto flex shrink-0 items-center gap-2 ps-2">
        <CheckIcon
          className={cn(
            'size-4 text-muted-foreground',
            selected ? undefined : 'invisible'
          )}
        />
        <ShortcutHint shortcut={shortcut} />
      </span>
    </ComboboxPrimitive.Item>
  )
}

/**
 * Controlled open state plus an imperative opener published through `openRef`,
 * so a parent hover or dialog hotkey can open the picker without first moving
 * focus to its trigger.
 */
export function usePickerOpener(
  openRef: RefObject<(() => void) | null> | undefined,
  disabled: boolean
): readonly [boolean, (next: boolean) => void] {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (openRef === undefined) {
      return
    }
    openRef.current = disabled ? null : () => setOpen(true)
    return () => {
      openRef.current = null
    }
  }, [openRef, disabled])

  return [open, setOpen]
}
