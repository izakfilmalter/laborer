/**
 * The Plate content surface and its scroll container.
 *
 * Chromeless by default: the description editor is meant to read as prose on
 * the dialog's own background, not as a bordered form control, so the visible
 * affordances live on the field wrapper rather than here.
 */

'use client'

import { cn } from '@laborer/ui/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'
import {
  PlateContainer,
  PlateContent,
  type PlateContentProps,
} from 'platejs/react'
import type * as React from 'react'

const editorContainerVariants = cva(
  'relative w-full cursor-text select-text overflow-y-auto caret-primary selection:bg-primary/25 focus-visible:outline-none',
  {
    defaultVariants: { variant: 'default' },
    variants: {
      variant: {
        default: 'h-full',
        none: '',
      },
    },
  }
)

function EditorContainer({
  className,
  variant,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof editorContainerVariants>) {
  return (
    <PlateContainer
      className={cn(editorContainerVariants({ variant }), className)}
      {...props}
    />
  )
}

const editorVariants = cva(
  cn(
    'group/editor',
    'relative w-full cursor-text select-text overflow-x-hidden whitespace-break-spaces break-words',
    'rounded-md focus-visible:outline-none',
    // Plate renders the placeholder as an absolutely positioned overlay whose
    // default styles assume a centered single-line field. Ours is a growing
    // prose block, so it has to sit on the first line instead.
    '**:data-slate-placeholder:top-auto **:data-slate-placeholder:translate-y-0 **:data-slate-placeholder:text-muted-foreground **:data-slate-placeholder:opacity-100!',
    '[&_strong]:font-semibold'
  ),
  {
    defaultVariants: { variant: 'default' },
    variants: {
      disabled: { true: 'cursor-not-allowed opacity-50' },
      variant: {
        default: 'size-full px-2 py-1 text-sm',
        none: '',
      },
    },
  }
)

type EditorProps = PlateContentProps &
  VariantProps<typeof editorVariants> & {
    ref?: React.RefObject<HTMLDivElement | null>
  }

function Editor({
  className,
  disabled = false,
  ref,
  variant,
  ...props
}: EditorProps) {
  return (
    <PlateContent
      className={cn(editorVariants({ disabled, variant }), className)}
      disableDefaultStyles
      disabled={disabled}
      ref={ref}
      {...props}
    />
  )
}

export { Editor, EditorContainer }
export type { EditorProps }
