/**
 * The popover that opens from a trigger character typed into the editor.
 *
 * It is an Ariakit combobox rather than the app's `Command`, because the thing
 * being typed into lives inside the contenteditable: the query is editor text
 * that has to survive backspacing back out of the menu, and the menu has to
 * anchor to the caret rather than to a mounted trigger element.
 */

'use client'

import {
  Combobox,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxItem,
  type ComboboxItemProps,
  ComboboxPopover,
  ComboboxProvider,
  Portal,
  useComboboxContext,
  useComboboxStore,
} from '@ariakit/react'
import { cn } from '@laborer/ui/lib/utils'
import { filterWords } from '@platejs/combobox'
import {
  type UseComboboxInputResult,
  useComboboxInput,
  useHTMLInputCursorState,
} from '@platejs/combobox/react'
import { cva } from 'class-variance-authority'
import type { PointRef, TElement } from 'platejs'
import { useComposedRef, useEditorRef } from 'platejs/react'
import {
  createContext,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

interface ComboboxCandidate {
  readonly group?: string | undefined
  readonly keywords?: readonly string[] | undefined
  readonly label?: string | undefined
  readonly value: string
}

type FilterFn = (item: ComboboxCandidate, search: string) => boolean

interface InlineComboboxContextValue {
  readonly filter: FilterFn | false
  readonly inputProps: UseComboboxInputResult['props']
  readonly inputRef: RefObject<HTMLInputElement | null>
  readonly removeInput: UseComboboxInputResult['removeInput']
  readonly setHasEmpty: (hasEmpty: boolean) => void
  readonly showTrigger: boolean
  readonly trigger: string
}

const InlineComboboxContext = createContext<InlineComboboxContextValue>(
  null as unknown as InlineComboboxContextValue
)

/** Any of an item's names may be what the person is reaching for. */
const defaultFilter: FilterFn = (
  { group, keywords = [], label, value },
  search
) =>
  Array.from(new Set([value, ...keywords, group, label].filter(Boolean))).some(
    (keyword) => filterWords(keyword as string, search)
  )

function InlineCombobox({
  children,
  element,
  filter = defaultFilter,
  showTrigger = true,
  trigger,
}: {
  readonly children: ReactNode
  readonly element: TElement
  readonly filter?: FilterFn | false
  readonly showTrigger?: boolean
  readonly trigger: string
}) {
  const editor = useEditorRef()
  const inputRef = useRef<HTMLInputElement>(null)
  const cursorState = useHTMLInputCursorState(inputRef)
  const [value, setValue] = useState('')
  const [hasEmpty, setHasEmpty] = useState(false)

  // Where the trigger character sat before the input replaced it. Abandoning
  // the menu has to put the typed text back exactly there, otherwise a stray
  // "/" lands wherever the selection happens to be.
  const insertPointRef = useRef<PointRef | null>(null)

  useEffect(() => {
    const path = editor.api.findPath(element)
    if (!path) {
      return
    }
    const point = editor.api.before(path)
    if (!point) {
      return
    }
    const pointRef = editor.api.pointRef(point)
    insertPointRef.current = pointRef
    return () => {
      if (insertPointRef.current === pointRef) {
        insertPointRef.current = null
      }
      pointRef.unref()
    }
  }, [editor, element])

  const { props: inputProps, removeInput } = useComboboxInput({
    cancelInputOnBlur: true,
    cursorState,
    onCancelInput: (cause) => {
      // Backspacing out of the trigger means the person deleted it on purpose;
      // every other exit was aimed elsewhere and should leave the text behind.
      if (cause !== 'backspace') {
        const at = insertPointRef.current?.current
        editor.tf.insertText(trigger + value, at ? { at } : {})
      }
      if (cause === 'arrowLeft' || cause === 'arrowRight') {
        editor.tf.move({ distance: 1, reverse: cause === 'arrowLeft' })
      }
    },
    ref: inputRef,
  })

  const store = useComboboxStore({
    // Under the trigger glyph, not centred on it: a centred menu drifts left of
    // the caret and clips against the dialog edge.
    placement: 'bottom-start',
    setValue: (next) => startTransition(() => setValue(next)),
  })
  const items = store.useState('items')

  // Arrow keys move a highlight; without a starting one, Enter would do nothing
  // on a freshly opened menu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `items` is the trigger, not a value the body reads — the highlight has to be restored whenever the list is rebuilt.
  useEffect(() => {
    if (!store.getState().activeId) {
      store.setActiveId(store.first())
    }
  }, [items, store])

  const contextValue = useMemo<InlineComboboxContextValue>(
    () => ({
      filter,
      inputProps,
      inputRef,
      removeInput,
      setHasEmpty,
      showTrigger,
      trigger,
    }),
    [filter, inputProps, removeInput, showTrigger, trigger]
  )

  return (
    <span contentEditable={false}>
      <ComboboxProvider open={items.length > 0 || hasEmpty} store={store}>
        <InlineComboboxContext.Provider value={contextValue}>
          {children}
        </InlineComboboxContext.Provider>
      </ComboboxProvider>
    </span>
  )
}

function InlineComboboxInput({
  className,
  ref: propRef,
}: {
  readonly className?: string
  readonly ref?: RefObject<HTMLInputElement | null>
}) {
  const { inputProps, inputRef, showTrigger, trigger } = useContext(
    InlineComboboxContext
  )
  const store = useComboboxContext()
  const value = store?.useState('value') ?? ''
  const ref = useComposedRef(propRef, inputRef)

  // An `<input>` cannot size itself to its content, so a hidden span holding
  // the same text sets the width and the real input lies on top of it.
  return (
    <>
      {showTrigger && trigger}
      <span className="relative min-h-[1lh]">
        <span
          aria-hidden="true"
          className="invisible overflow-hidden text-nowrap"
        >
          {value || '\u200B'}
        </span>
        <Combobox
          autoSelect
          className={cn(
            'absolute top-0 left-0 size-full bg-transparent outline-none',
            className
          )}
          ref={ref}
          value={value}
          // Plate declares these handlers as optional-and-possibly-undefined,
          // which `exactOptionalPropertyTypes` will not spread onto Ariakit's
          // stricter props. The values are what Ariakit wants; only the
          // declaration disagrees.
          {...(inputProps as Record<string, unknown>)}
        />
      </span>
    </>
  )
}

function InlineComboboxContent({
  className,
  ...props
}: Parameters<typeof ComboboxPopover>[0]) {
  const store = useComboboxContext()

  // Ariakit stops at the ends of the list; a short menu opened by a trigger
  // character reads better when it wraps, so held arrow keys keep cycling.
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!store) {
        return
      }
      const { activeId, items } = store.getState()
      if (items.length === 0) {
        return
      }
      const index = items.findIndex((item) => item.id === activeId)
      if (event.key === 'ArrowUp' && index <= 0) {
        event.preventDefault()
        store.setActiveId(store.last())
      } else if (event.key === 'ArrowDown' && index >= items.length - 1) {
        event.preventDefault()
        store.setActiveId(store.first())
      }
    },
    [store]
  )

  return (
    // Portalled so the dialog's own overflow and stacking cannot clip it.
    <Portal>
      <ComboboxPopover
        className={cn(
          'z-50 max-h-[min(18rem,var(--popover-available-height))] w-[280px] overflow-y-auto rounded-lg border bg-popover p-0 text-popover-foreground shadow-md',
          className
        )}
        flip
        // Ariakit anchors to the bare input; the menu should line up under the
        // whole chip, starting at the trigger glyph rather than after it.
        getAnchorRect={(anchor) => {
          const base = (anchor ??
            store?.getState().baseElement ??
            null) as HTMLElement | null
          const chip = base?.closest<HTMLElement>('[data-combobox-anchor]')
          return (chip ?? base)?.getBoundingClientRect() ?? null
        }}
        gutter={4}
        onKeyDownCapture={handleKeyDown}
        shift={0}
        {...props}
      />
    </Portal>
  )
}

const comboboxItemVariants = cva(
  'relative mx-1 flex h-8 select-none items-center gap-2 rounded-md px-2 text-foreground text-sm outline-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    defaultVariants: { interactive: true },
    variants: {
      interactive: {
        false: 'text-muted-foreground',
        true: 'cursor-pointer transition-colors hover:bg-accent hover:text-accent-foreground data-[active-item=true]:bg-accent data-[active-item=true]:text-accent-foreground',
      },
    },
  }
)

function InlineComboboxItem({
  className,
  focusEditor = true,
  group,
  keywords,
  label,
  onClick,
  ...props
}: ComboboxItemProps &
  Required<Pick<ComboboxItemProps, 'value'>> & {
    readonly focusEditor?: boolean
    readonly group?: string
    readonly keywords?: readonly string[]
    readonly label?: string
  }) {
  const { filter, removeInput } = useContext(InlineComboboxContext)
  const store = useComboboxContext()
  const search = store?.useState('value') ?? ''
  const { value } = props

  if (filter && !filter({ group, keywords, label, value }, search)) {
    return null
  }

  return (
    <ComboboxItem
      className={cn(comboboxItemVariants(), className)}
      onClick={(event) => {
        removeInput(focusEditor)
        onClick?.(event)
      }}
      {...props}
    />
  )
}

function InlineComboboxEmpty({
  children,
  className,
}: HTMLAttributes<HTMLDivElement>) {
  const { setHasEmpty } = useContext(InlineComboboxContext)
  const store = useComboboxContext()
  const items = store?.useState('items') ?? []

  // The menu stays open on no matches only because this is mounted, so it has
  // to tell the parent it exists.
  useEffect(() => {
    setHasEmpty(true)
    return () => setHasEmpty(false)
  }, [setHasEmpty])

  if (items.length > 0) {
    return null
  }

  return (
    <div
      className={cn(comboboxItemVariants({ interactive: false }), className)}
    >
      {children}
    </div>
  )
}

function InlineComboboxGroup({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxGroup>) {
  return (
    <ComboboxGroup
      className={cn(
        'hidden not-last:border-b py-1 [&:has([role=option])]:block',
        className
      )}
      {...props}
    />
  )
}

function InlineComboboxGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof ComboboxGroupLabel>) {
  return (
    <ComboboxGroupLabel
      className={cn(
        'mt-1 mb-1 px-3 font-medium text-muted-foreground text-xs',
        className
      )}
      {...props}
    />
  )
}

export {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
}
