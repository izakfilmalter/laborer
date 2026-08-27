import { cn } from '@laborer/ui/lib/utils'
import type { Components, Options } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

const remarkPlugins = [remarkGfm]

/**
 * Sanitize schema for markdown that embeds raw HTML.
 *
 * GitHub comment bodies routinely contain inline HTML (bot badges, `<img>`
 * wrapped in anchors, `<details>` disclosures). `rehype-raw` parses that HTML
 * and this schema strips anything unsafe before it reaches the DOM.
 */
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img ?? []), 'align', 'loading'],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary'],
} satisfies Parameters<typeof rehypeSanitize>[0]

const rehypePlugins: NonNullable<Options['rehypePlugins']> = [
  rehypeRaw,
  [rehypeSanitize, sanitizeSchema],
]

/**
 * Custom component overrides for react-markdown.
 *
 * Opens external links in a new tab and applies consistent styling
 * via the `.markdown-body` CSS class defined in index.css.
 */
const components: Components = {
  a: ({ children, href, ...rest }) => (
    <a href={href} rel="noopener noreferrer" target="_blank" {...rest}>
      {children}
    </a>
  ),
}

/**
 * Renders a markdown string as styled HTML.
 *
 * Uses `react-markdown` with `remark-gfm` for GitHub-flavored markdown
 * (tables, strikethrough, task lists, autolinks) plus `rehype-raw` and
 * `rehype-sanitize` so the inline HTML GitHub comments carry renders as
 * markup instead of escaped source text. Styling is provided by the
 * `.markdown-body` class in `index.css`.
 */
function Markdown({
  children,
  className,
}: {
  readonly children: string
  readonly className?: string
}) {
  return (
    <div className={cn('markdown-body', className)}>
      <ReactMarkdown
        components={components}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

export { Markdown }
