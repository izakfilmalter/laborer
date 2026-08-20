/**
 * Leaf and block renderers for the description editor's basic markdown nodes.
 *
 * Sizing is deliberately tighter than a document editor's: a card brief is read
 * inside a dialog, so headings step down quickly and blocks keep close company
 * rather than airing themselves out over a page.
 */

'use client'

import { cn } from '@laborer/ui/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'
import {
  PlateElement,
  type PlateElementProps,
  PlateLeaf,
  type PlateLeafProps,
  useFocused,
  useReadOnly,
  useSelected,
} from 'platejs/react'

function ParagraphElement(props: PlateElementProps) {
  return <PlateElement {...props} className="m-0 px-0 py-1" />
}

const headingVariants = cva('relative mb-1 font-semibold', {
  variants: {
    variant: {
      h1: 'mt-6 text-2xl tracking-tight',
      h2: 'mt-5 text-xl tracking-tight',
      h3: 'mt-4 text-lg tracking-tight',
      h4: 'mt-3 text-base tracking-tight',
      h5: 'mt-3 text-sm tracking-tight',
      h6: 'mt-3 text-muted-foreground text-sm tracking-tight',
    },
  },
})

function HeadingElement({
  variant = 'h1',
  ...props
}: PlateElementProps & VariantProps<typeof headingVariants>) {
  return (
    <PlateElement
      // The first block should not push itself away from the top of an
      // otherwise empty editor — a brief that opens on a heading would
      // otherwise start with a gap that reads as a rendering fault.
      as={variant ?? 'h1'}
      className={cn(headingVariants({ variant }), 'first:mt-0')}
      {...props}
    />
  )
}

const H1Element = (props: PlateElementProps) => (
  <HeadingElement variant="h1" {...props} />
)
const H2Element = (props: PlateElementProps) => (
  <HeadingElement variant="h2" {...props} />
)
const H3Element = (props: PlateElementProps) => (
  <HeadingElement variant="h3" {...props} />
)
const H4Element = (props: PlateElementProps) => (
  <HeadingElement variant="h4" {...props} />
)
const H5Element = (props: PlateElementProps) => (
  <HeadingElement variant="h5" {...props} />
)
const H6Element = (props: PlateElementProps) => (
  <HeadingElement variant="h6" {...props} />
)

function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="blockquote"
      className="my-1 border-l-2 pl-4 text-muted-foreground italic"
      {...props}
    />
  )
}

function HrElement(props: PlateElementProps) {
  const readOnly = useReadOnly()
  const selected = useSelected()
  const focused = useFocused()

  return (
    <PlateElement {...props}>
      <div className="py-3" contentEditable={false}>
        <hr
          className={cn(
            'h-0.5 rounded-sm border-none bg-muted bg-clip-content',
            selected && focused && 'ring-2 ring-ring ring-offset-2',
            !readOnly && 'cursor-pointer'
          )}
        />
      </div>
      {props.children}
    </PlateElement>
  )
}

function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="code"
      className="whitespace-pre-wrap rounded-sm bg-muted px-[0.3em] py-[0.15em] font-mono text-[0.9em]"
    />
  )
}

function HighlightLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="mark"
      className="rounded-sm bg-warning/25 text-inherit"
    />
  )
}

function KbdLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      {...props}
      as="kbd"
      className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs"
    />
  )
}

export {
  BlockquoteElement,
  CodeLeaf,
  H1Element,
  H2Element,
  H3Element,
  H4Element,
  H5Element,
  H6Element,
  HighlightLeaf,
  HrElement,
  KbdLeaf,
  ParagraphElement,
}
