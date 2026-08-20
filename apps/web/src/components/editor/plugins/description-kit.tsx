/**
 * The plugin set behind a card's description.
 *
 * The set is chosen to be exactly what survives a round trip to markdown, since
 * markdown is what the description actually stores and what the agent reads.
 * Nothing here can produce a node the serializer would drop on save.
 */

'use client'

import {
  BlockquoteRules,
  BoldRules,
  CodeRules,
  HeadingRules,
  HighlightRules,
  HorizontalRuleRules,
  ItalicRules,
  MarkComboRules,
  StrikethroughRules,
  UnderlineRules,
} from '@platejs/basic-nodes'
import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HighlightPlugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  KbdPlugin,
  StrikethroughPlugin,
  UnderlinePlugin,
} from '@platejs/basic-nodes/react'
import { CodeBlockRules } from '@platejs/code-block'
import {
  CodeBlockPlugin,
  CodeLinePlugin,
  CodeSyntaxPlugin,
} from '@platejs/code-block/react'
import { IndentPlugin } from '@platejs/indent/react'
import {
  BulletedListRules,
  isOrderedList,
  OrderedListRules,
  TaskListRules,
} from '@platejs/list'
import { ListPlugin } from '@platejs/list/react'
import { MarkdownPlugin } from '@platejs/markdown'
import { SlashInputPlugin, SlashPlugin } from '@platejs/slash-command/react'
import { all, createLowlight } from 'lowlight'
import { KEYS, type SlateEditor } from 'platejs'
import { ParagraphPlugin } from 'platejs/react'
import remarkGfm from 'remark-gfm'
import {
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
} from '@/components/editor/nodes/basic-nodes'
import { BlockList } from '@/components/editor/nodes/block-list'
import {
  CodeBlockElement,
  CodeLineElement,
  CodeSyntaxLeaf,
} from '@/components/editor/nodes/code-block-node'
import { SlashInputElement } from '@/components/editor/nodes/slash-node'

const lowlight = createLowlight(all)

/** Nothing here nests, so one indent step is all the list plumbing needs. */
const INDENT_OFFSET = 24

const INDENT_TARGETS = [
  ...KEYS.heading,
  KEYS.p,
  KEYS.blockquote,
  KEYS.codeBlock,
]

const headingPlugins = [
  [H1Plugin, H1Element, 1],
  [H2Plugin, H2Element, 2],
  [H3Plugin, H3Element, 3],
  [H4Plugin, H4Element, 4],
  [H5Plugin, H5Element, 5],
  [H6Plugin, H6Element, 6],
] as const

const DescriptionKit = [
  ParagraphPlugin.withComponent(ParagraphElement),
  ...headingPlugins.map(([plugin, component, level]) =>
    plugin.configure({
      inputRules: [HeadingRules.markdown()],
      node: { component },
      // Enter on an empty heading drops back to body text, so a brief does not
      // silently carry its heading style into the paragraph beneath it.
      rules: { break: { empty: 'reset' } },
      shortcuts: { toggle: { keys: `mod+alt+${String(level)}` } },
    })
  ),
  BlockquotePlugin.configure({
    inputRules: [BlockquoteRules.markdown()],
    node: { component: BlockquoteElement },
    shortcuts: { toggle: { keys: 'mod+shift+period' } },
  }),
  HorizontalRulePlugin.configure({
    inputRules: [
      HorizontalRuleRules.markdown({ variant: '-' }),
      HorizontalRuleRules.markdown({ variant: '_' }),
    ],
    node: { component: HrElement },
  }),
  BoldPlugin.configure({
    inputRules: [
      BoldRules.markdown({ variant: '*' }),
      BoldRules.markdown({ variant: '_' }),
      MarkComboRules.markdown({ variant: 'boldItalic' }),
    ],
  }),
  ItalicPlugin.configure({
    inputRules: [
      ItalicRules.markdown({ variant: '*' }),
      ItalicRules.markdown({ variant: '_' }),
    ],
  }),
  UnderlinePlugin.configure({ inputRules: [UnderlineRules.markdown()] }),
  StrikethroughPlugin.configure({
    inputRules: [StrikethroughRules.markdown()],
    shortcuts: { toggle: { keys: 'mod+shift+x' } },
  }),
  CodePlugin.configure({
    inputRules: [CodeRules.markdown()],
    node: { component: CodeLeaf },
    shortcuts: { toggle: { keys: 'mod+e' } },
  }),
  HighlightPlugin.configure({
    inputRules: [HighlightRules.markdown({ variant: '==' })],
    node: { component: HighlightLeaf },
    shortcuts: { toggle: { keys: 'mod+shift+h' } },
  }),
  KbdPlugin.withComponent(KbdLeaf),
  IndentPlugin.configure({
    inject: { targetPlugins: INDENT_TARGETS },
    options: { offset: INDENT_OFFSET },
  }),
  ListPlugin.configure({
    inject: {
      nodeProps: {
        nodeKey: KEYS.listType,
        query: ({ nodeProps }) => {
          const element = nodeProps.element
          return (
            element !== undefined &&
            Boolean(element.listStyleType) &&
            !isOrderedList(element)
          )
        },
        // Plate paints the marker via `list-item` display on the block itself,
        // which strips the implicit list semantics the markup needs back.
        transformProps: ({ props }) => ({
          ...props,
          role: 'listitem',
          style: { ...props.style, display: 'list-item' },
        }),
      },
      targetPlugins: INDENT_TARGETS,
    },
    inputRules: [
      BulletedListRules.markdown({ variant: '-' }),
      BulletedListRules.markdown({ variant: '*' }),
      OrderedListRules.markdown({ variant: '.' }),
      OrderedListRules.markdown({ variant: ')' }),
      TaskListRules.markdown({ checked: false }),
      TaskListRules.markdown({ checked: true }),
    ],
    render: { belowNodes: BlockList },
  }),
  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: 'match' })],
    node: { component: CodeBlockElement },
    options: { lowlight },
    shortcuts: { toggle: { keys: 'mod+alt+8' } },
  }),
  CodeLinePlugin.withComponent(CodeLineElement),
  CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),
  SlashPlugin.configure({
    options: {
      // Inside a fenced block a "/" is code, not a command.
      triggerQuery: (editor: SlateEditor) =>
        !editor.api.some({ match: { type: editor.getType(KEYS.codeBlock) } }),
    },
  }),
  SlashInputPlugin.withComponent(SlashInputElement),
  MarkdownPlugin.configure({
    options: {
      // GFM is the dialect a brief is written in: task lists, strikethrough,
      // and tables all appear in the briefs agents already receive.
      remarkPlugins: [remarkGfm],
      // Match how briefs are already written, so opening a card and saving an
      // unrelated edit does not rewrite every bullet and rule in it.
      remarkStringifyOptions: { bullet: '-', rule: '-' },
    },
  }),
]

export { DescriptionKit }
