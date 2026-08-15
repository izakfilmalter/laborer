/**
 * The multi-select label picker.
 *
 * Presentational on purpose: it owns the popup, the filter, and the inline
 * "create label" row, but not where labels come from or how a selection is
 * saved. `TaskLabelsControl` supplies both.
 */

'use client'

import { Combobox as ComboboxPrimitive } from '@base-ui/react'
import { Plus } from 'lucide-react'
import type { ReactElement, ReactNode, RefObject } from 'react'
import { useMemo, useState } from 'react'
import { Combobox, ComboboxEmpty, ComboboxList } from '@laborer/ui/components/combobox'
import {
  ComboboxOption,
  PickerHeader,
  PickerPopup,
  usePickerOpener,
} from '@laborer/ui/components/combobox-picker'

import { LabelDot, type TaskLabelOption } from './label-chips'

/**
 * The sentinel row that offers to create the typed name. Its display label
 * mirrors the query so the combobox's own filter always keeps it visible.
 */
const CREATE_LABEL_ITEM = '__create-label__'

export interface LabelsPickerProps {
  readonly disabled?: boolean
  /**
   * Creates a label and adds it to the selection. Omit it to hide the create
   * row — a surface that cannot write labels should not offer to.
   */
  readonly onCreateLabel?: (name: string) => void
  readonly onValueChange: (value: readonly string[]) => void
  /** Published so a parent's "L" hotkey can open the picker without focus. */
  readonly openRef?: RefObject<(() => void) | null> | undefined
  readonly options: readonly TaskLabelOption[]
  readonly trigger: ReactNode
  readonly triggerLabel?: string
  readonly value: readonly string[]
}

/**
 * A multi-select list of labels with a leading colored dot and a trailing
 * check on every selected row. The popup stays open across selections, so
 * applying three labels is three clicks rather than three round trips.
 */
export function LabelsPicker({
  value,
  options,
  onValueChange,
  onCreateLabel,
  trigger,
  triggerLabel = 'Add labels',
  disabled = false,
  openRef,
}: LabelsPickerProps): ReactElement {
  const [query, setQuery] = useState('')
  const trimmedQuery = query.trim()
  const canCreate =
    onCreateLabel !== undefined &&
    trimmedQuery !== '' &&
    !options.some(
      (option) =>
        option.name.trim().toLowerCase() === trimmedQuery.toLowerCase()
    )
  const items = useMemo(() => {
    const ids = options.map((option) => option.id)
    return canCreate ? [...ids, CREATE_LABEL_ITEM] : ids
  }, [options, canCreate])
  const [open, setOpen] = usePickerOpener(openRef, disabled)

  const labelFor = (candidate: string) =>
    candidate === CREATE_LABEL_ITEM
      ? query
      : (options.find((option) => option.id === candidate)?.name ?? candidate)

  return (
    <Combobox<string, true>
      disabled={disabled}
      items={items}
      itemToStringLabel={labelFor}
      multiple
      onInputValueChange={setQuery}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery('')
        }
      }}
      onValueChange={(next) => {
        const selected = next ?? []
        if (!selected.includes(CREATE_LABEL_ITEM)) {
          onValueChange(selected)
          return
        }
        if (canCreate) {
          onCreateLabel(trimmedQuery)
        }
        onValueChange(
          selected.filter((candidate) => candidate !== CREATE_LABEL_ITEM)
        )
      }}
      open={open}
      value={value as string[]}
    >
      <ComboboxPrimitive.Trigger
        aria-label={triggerLabel}
        className="inline-flex cursor-pointer items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-60"
        data-slot="labels-picker-trigger"
        // Cards are draggable and often clickable; the picker must not start
        // a drag or open the card behind it.
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (disabled) {
            return
          }
          if (event.key === 'l' || event.key === 'L') {
            event.preventDefault()
            setOpen(true)
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {trigger}
      </ComboboxPrimitive.Trigger>
      <PickerPopup popupProps={{ onClick: (event) => event.stopPropagation() }}>
        <PickerHeader placeholder="Add labels..." shortcut="L" />
        <ComboboxEmpty>No labels.</ComboboxEmpty>
        <ComboboxList>
          {options.map((option) => (
            <ComboboxOption
              key={option.id}
              selected={value.includes(option.id)}
              value={option.id}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                <LabelDot className="size-2.5" label={option} />
              </span>
              <span className="truncate">{option.name}</span>
            </ComboboxOption>
          ))}
          {canCreate ? (
            <ComboboxOption selected={false} value={CREATE_LABEL_ITEM}>
              <span className="flex size-4 shrink-0 items-center justify-center">
                <Plus className="size-3.5" />
              </span>
              <span className="truncate">Create label “{trimmedQuery}”</span>
            </ComboboxOption>
          ) : null}
        </ComboboxList>
      </PickerPopup>
    </Combobox>
  )
}
