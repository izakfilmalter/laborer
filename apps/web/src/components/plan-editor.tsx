/**
 * Plan editor component using Plate.js for WYSIWYG markdown editing.
 *
 * Loads PRD markdown content via `prd.read` RPC, displays it in a Plate.js
 * editor with common markdown plugins, and saves changes back via `prd.update`
 * RPC with debounced auto-save.
 *
 * @see Issue #190: Plan detail view: Plate.js markdown editor
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
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
  ItalicPlugin,
  StrikethroughPlugin,
} from '@platejs/basic-nodes/react'
import { CodeBlockPlugin, CodeLinePlugin } from '@platejs/code-block/react'
import { LinkPlugin } from '@platejs/link/react'
import { ListPlugin } from '@platejs/list/react'
import { MarkdownPlugin } from '@platejs/markdown'
import {
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from '@platejs/table/react'
import { AlertCircle, ArrowLeft, FileText, Loader2, Save } from 'lucide-react'
import {
  Plate,
  PlateContent,
  PlateElement,
  type PlateElementProps,
  PlateLeaf,
  type PlateLeafProps,
  usePlateEditor,
} from 'platejs/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn, extractErrorMessage } from '@/lib/utils'

// ─── Element Components ────────────────────────────────────────────────

function H1Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h1"
      {...props}
      className={cn('mt-6 mb-4 font-bold text-3xl', props.className)}
    />
  )
}
function H2Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h2"
      {...props}
      className={cn('mt-5 mb-3 font-bold text-2xl', props.className)}
    />
  )
}
function H3Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h3"
      {...props}
      className={cn('mt-4 mb-2 font-semibold text-xl', props.className)}
    />
  )
}
function H4Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h4"
      {...props}
      className={cn('mt-3 mb-2 font-semibold text-lg', props.className)}
    />
  )
}
function H5Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h5"
      {...props}
      className={cn('mt-3 mb-1 font-medium text-base', props.className)}
    />
  )
}
function H6Element(props: PlateElementProps) {
  return (
    <PlateElement
      as="h6"
      {...props}
      className={cn('mt-2 mb-1 font-medium text-sm', props.className)}
    />
  )
}

function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="blockquote"
      className="my-2 border-muted-foreground/30 border-l-2 pl-4 text-muted-foreground italic"
      {...props}
    />
  )
}

function CodeBlockElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="pre"
      className="my-3 rounded-md bg-muted p-4 font-mono text-sm"
      {...props}
    />
  )
}

function CodeLineElement(props: PlateElementProps) {
  return <PlateElement as="div" {...props} />
}

function LinkElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="a"
      className="cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      {...props}
    />
  )
}

function TableElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="table"
      className="my-3 w-full border-collapse"
      {...props}
    />
  )
}

function TableRowElement(props: PlateElementProps) {
  return <PlateElement as="tr" className="border-b" {...props} />
}

function TableCellElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="td"
      className="border px-3 py-2 text-left text-sm"
      {...props}
    />
  )
}

// ─── Leaf Components ───────────────────────────────────────────────────

function BoldLeaf(props: PlateLeafProps) {
  return <PlateLeaf as="strong" {...props} />
}

function ItalicLeaf(props: PlateLeafProps) {
  return <PlateLeaf as="em" {...props} />
}

function StrikethroughLeaf(props: PlateLeafProps) {
  return <PlateLeaf as="s" {...props} />
}

function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf
      as="code"
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm"
      {...props}
    />
  )
}

// ─── Plate Plugin Config ───────────────────────────────────────────────

const editorPlugins = [
  // Block elements
  H1Plugin.withComponent(H1Element),
  H2Plugin.withComponent(H2Element),
  H3Plugin.withComponent(H3Element),
  H4Plugin.withComponent(H4Element),
  H5Plugin.withComponent(H5Element),
  H6Plugin.withComponent(H6Element),
  BlockquotePlugin.withComponent(BlockquoteElement),
  CodeBlockPlugin.withComponent(CodeBlockElement),
  CodeLinePlugin.withComponent(CodeLineElement),
  LinkPlugin.withComponent(LinkElement),
  ListPlugin,
  TablePlugin.withComponent(TableElement),
  TableRowPlugin.withComponent(TableRowElement),
  TableCellPlugin.withComponent(TableCellElement),
  // Inline marks
  BoldPlugin.withComponent(BoldLeaf),
  ItalicPlugin.withComponent(ItalicLeaf),
  StrikethroughPlugin.withComponent(StrikethroughLeaf),
  CodePlugin.withComponent(CodeLeaf),
  // Markdown serialization
  MarkdownPlugin.configure({
    options: {
      remarkPlugins: [remarkGfm],
    },
  }),
]

// ─── RPC Atoms ─────────────────────────────────────────────────────────

const prdReadMutation = LaborerClient.mutation('prd.read')
const prdUpdateMutation = LaborerClient.mutation('prd.update')

// ─── Debounce Hook ─────────────────────────────────────────────────────

function useDebouncedCallback<T extends (...args: never[]) => void>(
  callback: T,
  delay: number
): T {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbackRef = useRef(callback)
  callbackRef.current = callback

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => {
        callbackRef.current(...args)
      }, delay)
    },
    [delay]
  ) as T
}

// ─── Component ─────────────────────────────────────────────────────────

interface PlanEditorProps {
  readonly onBack: () => void
  readonly prdId: string
}

type EditorStatus = 'loading' | 'ready' | 'saving' | 'error'

function PlanEditor({ prdId, onBack }: PlanEditorProps) {
  const [status, setStatus] = useState<EditorStatus>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [prdTitle, setPrdTitle] = useState('')
  const [initialMarkdown, setInitialMarkdown] = useState<string | null>(null)
  const [saveIndicator, setSaveIndicator] = useState<
    'saved' | 'unsaved' | 'saving'
  >('saved')

  const readPrd = useAtomSet(prdReadMutation, { mode: 'promise' })
  const updatePrd = useAtomSet(prdUpdateMutation, { mode: 'promise' })

  // Track the editor instance for serialization
  const editorRef = useRef<ReturnType<typeof usePlateEditor> | null>(null)

  // Load PRD content on mount
  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrorMessage(null)

    readPrd({ payload: { prdId } })
      .then((result) => {
        if (cancelled) {
          return
        }
        setPrdTitle(result.title)
        setInitialMarkdown(result.content)
        setStatus('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        const message = extractErrorMessage(error)
        setErrorMessage(message)
        setStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [prdId, readPrd])

  // Save function — serializes editor content to markdown and calls prd.update
  const saveContent = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) {
      return
    }

    try {
      setSaveIndicator('saving')
      const markdown = editor.api.markdown.serialize()
      await updatePrd({ payload: { prdId, content: markdown } })
      setSaveIndicator('saved')
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(`Failed to save: ${message}`)
      setSaveIndicator('unsaved')
    }
  }, [prdId, updatePrd])

  // Debounced auto-save (1.5s after last edit)
  const debouncedSave = useDebouncedCallback(() => {
    saveContent().catch(() => {
      // error already handled in saveContent
    })
  }, 1500)

  // Handle editor changes
  const handleChange = useCallback(() => {
    setSaveIndicator('unsaved')
    debouncedSave()
  }, [debouncedSave])

  // Save on blur
  const handleBlur = useCallback(() => {
    saveContent().catch(() => {
      // error already handled in saveContent
    })
  }, [saveContent])

  // ── Loading State ──────────────────────────────────────────────────
  if (status === 'loading') {
    return (
      <div className="flex h-full flex-col">
        <EditorHeader onBack={onBack} title="" />
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // ── Error State ────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="flex h-full flex-col">
        <EditorHeader onBack={onBack} title="" />
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <AlertCircle className="size-8 text-destructive" />
          <p className="text-center text-sm">
            {errorMessage ?? 'Failed to load plan'}
          </p>
          <Button onClick={onBack} size="sm" variant="outline">
            Go back
          </Button>
        </div>
      </div>
    )
  }

  // ── Editor ─────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col">
      <EditorHeader
        onBack={onBack}
        saveIndicator={saveIndicator}
        title={prdTitle}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {initialMarkdown !== null && (
          <PlateEditorInner
            editorRef={editorRef}
            initialMarkdown={initialMarkdown}
            onBlur={handleBlur}
            onChange={handleChange}
          />
        )}
      </div>
    </div>
  )
}

// ─── Editor Header Bar ─────────────────────────────────────────────────

function EditorHeader({
  onBack,
  title,
  saveIndicator,
}: {
  readonly onBack: () => void
  readonly title: string
  readonly saveIndicator?: 'saved' | 'unsaved' | 'saving'
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Back to panels"
              onClick={onBack}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <ArrowLeft className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Back to panels</TooltipContent>
      </Tooltip>
      <FileText className="size-3.5 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium text-sm">{title}</span>
      <div className="flex-1" />
      {saveIndicator && (
        <span
          className={cn(
            'flex items-center gap-1 text-xs',
            saveIndicator === 'saved' && 'text-muted-foreground',
            saveIndicator === 'unsaved' && 'text-warning',
            saveIndicator === 'saving' && 'text-muted-foreground'
          )}
        >
          {saveIndicator === 'saving' && (
            <Loader2 className="size-3 animate-spin" />
          )}
          {saveIndicator === 'saved' && <Save className="size-3" />}
          {saveIndicator === 'saved' && 'Saved'}
          {saveIndicator === 'unsaved' && 'Unsaved changes'}
          {saveIndicator === 'saving' && 'Saving...'}
        </span>
      )}
    </div>
  )
}

// ─── Inner Editor (handles Plate instance) ──────────────────────────────

function PlateEditorInner({
  initialMarkdown,
  onChange,
  onBlur,
  editorRef,
}: {
  readonly initialMarkdown: string
  readonly onChange: () => void
  readonly onBlur: () => void
  readonly editorRef: React.MutableRefObject<ReturnType<
    typeof usePlateEditor
  > | null>
}) {
  const editor = usePlateEditor({
    plugins: editorPlugins,
    value: (editor) =>
      editor.getApi(MarkdownPlugin).markdown.deserialize(initialMarkdown),
  })

  // Expose editor to parent for serialization
  editorRef.current = editor

  return (
    <Plate editor={editor} onChange={onChange}>
      <PlateContent
        className="mx-auto max-w-3xl px-8 py-6 text-sm leading-relaxed outline-none [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6"
        onBlur={onBlur}
        placeholder="Start writing your PRD..."
      />
    </Plate>
  )
}

export { PlanEditor }
