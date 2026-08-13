import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

const remarkPlugins = [remarkGfm]

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
 * (tables, strikethrough, task lists, autolinks). Styling is provided by
 * the `.markdown-body` class in `index.css`.
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
      <ReactMarkdown components={components} remarkPlugins={remarkPlugins}>
        {children}
      </ReactMarkdown>
    </div>
  )
}

export { Markdown }
