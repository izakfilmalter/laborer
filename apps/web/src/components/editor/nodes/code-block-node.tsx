/**
 * Fenced code blocks, with the language picker and copy button that make a
 * pasted snippet usable inside a brief.
 *
 * A brief is full of commands, paths, and diffs, so the language matters: it is
 * what the round-trip back to markdown writes after the opening fence, and what
 * the agent reads. The picker is therefore an editing control, not decoration.
 */

'use client'

import { Button } from '@laborer/ui/components/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@laborer/ui/components/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@laborer/ui/components/popover'
import { cn } from '@laborer/ui/lib/utils'
import { formatCodeBlock, isLangSupported } from '@platejs/code-block'
import { BracesIcon, CheckIcon, CopyIcon } from 'lucide-react'
import { NodeApi, type TCodeBlockElement, type TCodeSyntaxLeaf } from 'platejs'
import {
  PlateElement,
  type PlateElementProps,
  PlateLeaf,
  type PlateLeafProps,
  useEditorRef,
  useElement,
  useReadOnly,
} from 'platejs/react'
import { useState } from 'react'

/** How long the copy button stays confirmed before returning to its icon. */
const COPIED_FEEDBACK_MS = 2000

/** The languages offered by the picker, labelled as people say them. */
const CODE_BLOCK_LANGUAGES: readonly { label: string; value: string }[] = [
  { label: 'Plain Text', value: 'plaintext' },
  { label: 'Bash', value: 'bash' },
  { label: 'C', value: 'c' },
  { label: 'C#', value: 'csharp' },
  { label: 'C++', value: 'cpp' },
  { label: 'CSS', value: 'css' },
  { label: 'Diff', value: 'diff' },
  { label: 'Docker', value: 'dockerfile' },
  { label: 'Go', value: 'go' },
  { label: 'GraphQL', value: 'graphql' },
  { label: 'HTML', value: 'html' },
  { label: 'Java', value: 'java' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'JSON', value: 'json' },
  { label: 'Kotlin', value: 'kotlin' },
  { label: 'Markdown', value: 'markdown' },
  { label: 'PHP', value: 'php' },
  { label: 'Python', value: 'python' },
  { label: 'Ruby', value: 'ruby' },
  { label: 'Rust', value: 'rust' },
  { label: 'SCSS', value: 'scss' },
  { label: 'Shell', value: 'shell' },
  { label: 'SQL', value: 'sql' },
  { label: 'Swift', value: 'swift' },
  { label: 'TOML', value: 'toml' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'XML', value: 'xml' },
  { label: 'YAML', value: 'yaml' },
]

function languageLabel(lang?: string | null): string | null {
  const value = lang?.trim()
  if (!value) {
    return null
  }
  return (
    CODE_BLOCK_LANGUAGES.find((language) => language.value === value)?.label ??
    value
  )
}

function CodeBlockElement(props: PlateElementProps<TCodeBlockElement>) {
  const { editor, element } = props

  return (
    <PlateElement className="py-1" {...props}>
      <div className="group/code relative rounded-md border bg-muted/40">
        <pre className="overflow-x-auto p-3 pr-4 font-mono text-xs leading-relaxed [tab-size:2]">
          <code>{props.children}</code>
        </pre>
        {/* The controls sit outside the editable tree: a caret must never be
            able to land inside them. */}
        <div
          className="absolute top-1 right-1 z-10 flex select-none gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/code:opacity-100"
          contentEditable={false}
        >
          {isLangSupported(element.lang) && (
            <Button
              aria-label="Format code"
              onClick={() => formatCodeBlock(editor, { element })}
              size="icon-xs"
              variant="ghost"
            >
              <BracesIcon className="text-muted-foreground" />
            </Button>
          )}
          <CodeBlockLanguagePicker />
          <CopyCodeButton value={() => NodeApi.string(element)} />
        </div>
      </div>
    </PlateElement>
  )
}

function CodeBlockLanguagePicker() {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const readOnly = useReadOnly()
  const editor = useEditorRef()
  const element = useElement<TCodeBlockElement>()
  const value = element.lang || 'plaintext'

  if (readOnly) {
    const label = languageLabel(element.lang)
    return label ? (
      <span className="flex h-6 select-none items-center px-2 text-muted-foreground text-xs">
        {label}
      </span>
    ) : null
  }

  const matches = CODE_BLOCK_LANGUAGES.filter(
    (language) =>
      search.length === 0 ||
      language.label.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setSearch('')
        }
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <Button
            aria-label="Code language"
            className="text-muted-foreground"
            size="xs"
            variant="ghost"
          >
            {languageLabel(value) ?? 'Plain Text'}
          </Button>
        }
      />
      <PopoverContent className="w-[200px] p-0">
        <Command shouldFilter={false}>
          <CommandInput
            onValueChange={setSearch}
            placeholder="Search language…"
            value={search}
          />
          <CommandEmpty>No language found.</CommandEmpty>
          <CommandList className="max-h-64">
            <CommandGroup>
              {matches.map((language) => (
                <CommandItem
                  key={language.value}
                  onSelect={() => {
                    editor.tf.setNodes<TCodeBlockElement>(
                      { lang: language.value },
                      { at: element }
                    )
                    setOpen(false)
                  }}
                  value={language.value}
                >
                  <CheckIcon
                    className={cn(
                      value === language.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {language.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function CopyCodeButton({ value }: { readonly value: () => string }) {
  const [copied, setCopied] = useState(false)

  return (
    <Button
      aria-label={copied ? 'Copied' : 'Copy code'}
      className="text-muted-foreground"
      onClick={() => {
        navigator.clipboard.writeText(value()).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
          },
          // A denied clipboard permission is the browser's answer, not ours to
          // report — confirming a copy that did not happen would be worse.
          () => undefined
        )
      }}
      size="icon-xs"
      variant="ghost"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

function CodeLineElement(props: PlateElementProps) {
  return <PlateElement {...props} />
}

function CodeSyntaxLeaf(props: PlateLeafProps<TCodeSyntaxLeaf>) {
  return <PlateLeaf className={props.leaf.className as string} {...props} />
}

export { CodeBlockElement, CodeLineElement, CodeSyntaxLeaf }
