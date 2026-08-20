/**
 * The `/` menu: every block the editor can make, without a toolbar.
 *
 * Markdown shortcuts already cover these for anyone who knows them. This is the
 * discoverable half of the same set, so the two never disagree about what a
 * brief can contain.
 */

'use client'

import {
  Code2,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrdered,
  MinusIcon,
  PilcrowIcon,
  Quote,
  SquareCheckIcon,
} from 'lucide-react'
import { KEYS, type TComboboxInputElement } from 'platejs'
import { PlateElement, type PlateElementProps } from 'platejs/react'
import type { ReactNode } from 'react'
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from '@/components/editor/nodes/inline-combobox'
import { insertBlock } from '@/components/editor/transforms'

const BLOCK_ITEMS: readonly {
  readonly icon: ReactNode
  readonly keywords: readonly string[]
  readonly label: string
  readonly value: string
}[] = [
  {
    icon: <PilcrowIcon />,
    keywords: ['paragraph'],
    label: 'Text',
    value: KEYS.p,
  },
  {
    icon: <Heading1Icon />,
    keywords: ['title', 'h1', '#'],
    label: 'Heading 1',
    value: KEYS.h1,
  },
  {
    icon: <Heading2Icon />,
    keywords: ['subtitle', 'h2', '##'],
    label: 'Heading 2',
    value: KEYS.h2,
  },
  {
    icon: <Heading3Icon />,
    keywords: ['subtitle', 'h3', '###'],
    label: 'Heading 3',
    value: KEYS.h3,
  },
  {
    icon: <ListIcon />,
    keywords: ['unordered', 'ul', '-'],
    label: 'Bulleted list',
    value: KEYS.ul,
  },
  {
    icon: <ListOrdered />,
    keywords: ['ordered', 'ol', '1.'],
    label: 'Numbered list',
    value: KEYS.ol,
  },
  {
    icon: <SquareCheckIcon />,
    keywords: ['checklist', 'task', 'checkbox', '[]'],
    label: 'To-do list',
    value: KEYS.listTodo,
  },
  {
    icon: <Code2 />,
    keywords: ['```', 'snippet', 'fence'],
    label: 'Code block',
    value: KEYS.codeBlock,
  },
  {
    icon: <Quote />,
    keywords: ['citation', 'blockquote', 'quote', '>'],
    label: 'Blockquote',
    value: KEYS.blockquote,
  },
  {
    icon: <MinusIcon />,
    keywords: ['divider', 'rule', '---'],
    label: 'Divider',
    value: KEYS.hr,
  },
]

const GROUP_LABEL = 'Blocks'

function SlashInputElement(props: PlateElementProps<TComboboxInputElement>) {
  const { editor, element } = props

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} showTrigger={false} trigger="/">
        <span
          className="-my-0.5 inline-block rounded-sm bg-muted px-1.5 py-0.5 align-baseline text-sm ring-ring focus-within:ring-2"
          data-combobox-anchor
        >
          /<InlineComboboxInput />
        </span>
        <InlineComboboxContent>
          <InlineComboboxEmpty>No matching block</InlineComboboxEmpty>
          <InlineComboboxGroup>
            <InlineComboboxGroupLabel>{GROUP_LABEL}</InlineComboboxGroupLabel>
            {BLOCK_ITEMS.map(({ icon, keywords, label, value }) => (
              <InlineComboboxItem
                group={GROUP_LABEL}
                key={value}
                keywords={keywords}
                label={label}
                onClick={() => insertBlock(editor, value, { upsert: true })}
                value={value}
              >
                <span className="text-muted-foreground">{icon}</span>
                {label}
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  )
}

export { SlashInputElement }
