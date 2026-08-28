/**
 * Command palette primitives, ported from t3code.
 *
 * Built on Base UI's Dialog (overlay chrome) and Autocomplete (input, list,
 * highlight machinery) rather than cmdk. The Autocomplete is rendered
 * `inline` + `open` with `mode="none"` so all filtering stays in
 * `command-palette.logic.ts`.
 */

import { Autocomplete as AutocompletePrimitive } from '@base-ui/react/autocomplete'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import { cn } from '@laborer/ui/lib/utils'
import { SearchIcon } from 'lucide-react'
import type * as React from 'react'

const DIALOG_BACKDROP_CLASS =
  'dialog-backdrop fixed inset-0 z-50 transition-all duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0'

const DIALOG_POPUP_CLASS =
  'dialog-glass relative flex min-h-0 w-full min-w-0 flex-col rounded-2xl border outline-none transition-[scale,opacity,translate] duration-200 ease-in-out will-change-transform data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0'

const CommandDialog = DialogPrimitive.Root

function CommandDialogPopup({
  className,
  children,
  onBackdropPointerDown,
  ...props
}: DialogPrimitive.Popup.Props & {
  onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        className={DIALOG_BACKDROP_CLASS}
        data-slot="command-dialog-backdrop"
        onPointerDown={onBackdropPointerDown}
      />
      <DialogPrimitive.Viewport
        className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[max(--spacing(4),4vh)] sm:py-[10vh]"
        data-slot="command-dialog-viewport"
      >
        <DialogPrimitive.Popup
          className={cn(
            DIALOG_POPUP_CLASS,
            'pointer-events-auto max-h-105 max-w-xl overflow-hidden p-0 text-foreground',
            className
          )}
          data-slot="command-dialog-popup"
          {...props}
        >
          {children}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Viewport>
    </DialogPrimitive.Portal>
  )
}

function Command({
  autoHighlight = 'always',
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof AutocompletePrimitive.Root>) {
  return (
    <AutocompletePrimitive.Root
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  )
}

function CommandInput({
  className,
  startAddon,
  ...props
}: AutocompletePrimitive.Input.Props & {
  startAddon?: React.ReactNode
}) {
  return (
    <div className="px-[var(--command-shell-inset)] py-1.5">
      <div className="relative w-full text-foreground">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 start-0 z-10 flex items-center ps-[calc(var(--command-shell-inset)+0.125rem)] opacity-80 [&:has(button)]:pointer-events-auto [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
          data-slot="command-input-start-addon"
        >
          {startAddon ?? <SearchIcon className="text-muted-foreground" />}
        </div>
        <AutocompletePrimitive.Input
          autoFocus
          className={cn(
            'h-10 w-full border-none bg-transparent py-1 pe-3 text-base text-foreground outline-none placeholder:text-muted-foreground sm:text-sm',
            'ps-[calc(var(--command-shell-inset)+1.75rem)]',
            className
          )}
          data-slot="command-input"
          {...props}
        />
      </div>
    </div>
  )
}

function CommandPanel({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'relative min-h-0 overflow-hidden rounded-t-xl bg-transparent [touch-action:pan-y]',
        className
      )}
      data-slot="command-panel"
      {...props}
    />
  )
}

function CommandList({
  className,
  ...props
}: AutocompletePrimitive.List.Props) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <AutocompletePrimitive.List
        className={cn('not-empty:scroll-py-2 not-empty:p-2', className)}
        data-slot="command-list"
        {...props}
      />
    </ScrollArea>
  )
}

function CommandGroup({
  className,
  ...props
}: AutocompletePrimitive.Group.Props) {
  return (
    <AutocompletePrimitive.Group
      className={cn('[[role=group]+&]:mt-1.5', className)}
      data-slot="command-group"
      {...props}
    />
  )
}

function CommandGroupLabel({
  className,
  ...props
}: AutocompletePrimitive.GroupLabel.Props) {
  return (
    <AutocompletePrimitive.GroupLabel
      className={cn(
        'px-2 py-1.5 font-medium text-muted-foreground text-xs',
        className
      )}
      data-slot="command-group-label"
      {...props}
    />
  )
}

function CommandCollection(props: AutocompletePrimitive.Collection.Props) {
  return (
    <AutocompletePrimitive.Collection
      data-slot="command-collection"
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      className={cn(
        'flex min-h-8 cursor-default select-none items-center rounded-sm px-2 py-1.5 text-base outline-none data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm',
        className
      )}
      data-slot="command-item"
      {...props}
    />
  )
}

function CommandShortcut({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn(
        'ms-auto shrink-0 font-medium font-sans text-muted-foreground text-xs tracking-widest',
        className
      )}
      data-slot="command-shortcut"
      {...props}
    />
  )
}

function CommandFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'relative flex items-center justify-between gap-2 rounded-b-[calc(var(--radius-2xl)-1px)] bg-foreground/[0.025] px-[var(--command-content-inset)] py-2.5 font-medium text-muted-foreground text-sm [&_[data-slot=kbd-group]]:font-sans [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground',
        className
      )}
      data-slot="command-footer"
      {...props}
    />
  )
}

export {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
}
