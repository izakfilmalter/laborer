/**
 * Splitting a pull request body into markdown runs and the uploads embedded
 * in it. Ported verbatim from t3code's `pullRequestMarkdown.logic.ts`.
 */

/** `id` is positional on purpose: the same attachment can be embedded twice. */
export type PullRequestBodySegment =
  | { readonly id: string; readonly kind: 'markdown'; readonly text: string }
  | {
      readonly id: string
      readonly kind: 'attachment'
      readonly url: string
      /**
       * What the reader can be told the upload is. GitHub writes a dropped
       * image into the body as an `<img>` tag, so a bare attachment link on
       * its own line is what it does with a video.
       */
      readonly media: 'video' | 'unknown'
    }

const FENCE_PATTERN = /^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)$/u
/**
 * How far a `<video>` tag may reach for its closing tag. Real embeds are
 * one to three lines; the bound keeps an unclosed tag from rescanning.
 */
const VIDEO_TAG_MAX_LINES = 8
/** Four spaces open an indented code block, so its contents stay verbatim. */
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu
/** A dropped video becomes a bare asset link; a dropped image an `<img>` tag. */
const GITHUB_ASSET_PATTERN =
  /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/iu
const VIDEO_TAG_SRC_PATTERN =
  /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu
/** Only a tag that owns its line is an embed; inline, it is prose. */
const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu
const LEADING_BLANK_LINES = /^\n+/u
const TRAILING_WHITESPACE = /\s+$/u

/** Anything else — `javascript:`, `data:`, a relative path — is not an upload. */
function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function attachmentFromLine(
  line: string
): { url: string; media: 'video' | 'unknown' } | null {
  const url = BARE_URL_PATTERN.exec(line.trim())?.[1]
  if (url === undefined || !isWebUrl(url)) {
    return null
  }
  if (VIDEO_EXTENSION_PATTERN.test(url) || GITHUB_ASSET_PATTERN.test(url)) {
    return { url, media: 'video' }
  }
  return null
}

/**
 * Splits a body into markdown runs and the uploads the markdown renderer
 * drops. Fenced code is copied through untouched so a snippet that happens
 * to contain a link is never lifted out of it.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported near-verbatim from t3code's fence-aware body splitter.
export function splitPullRequestBody(
  body: string
): readonly PullRequestBodySegment[] {
  const segments: PullRequestBodySegment[] = []
  const markdown: string[] = []
  let openFence: string | null = null

  // Blank lines around a run are dropped, but never leading spaces: four
  // of them open an indented code block.
  const flushMarkdown = () => {
    const text = markdown
      .join('\n')
      .replace(LEADING_BLANK_LINES, '')
      .replace(TRAILING_WHITESPACE, '')
    markdown.length = 0
    if (text.trim().length > 0) {
      segments.push({
        id: `markdown:${segments.length}`,
        kind: 'markdown',
        text,
      })
    }
  }

  const lines = body.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fenceMatch = FENCE_PATTERN.exec(line)
    if (fenceMatch !== null) {
      const fence = fenceMatch[1] ?? ''
      // A fence closes only on the same marker, at least as long as the one
      // that opened it, with nothing after it.
      const closes =
        openFence !== null &&
        fence[0] === openFence[0] &&
        fence.length >= openFence.length &&
        (fenceMatch[2] ?? '').trim().length === 0
      if (openFence === null) {
        openFence = fence
      } else if (closes) {
        openFence = null
      }
      markdown.push(line)
      continue
    }
    if (openFence !== null || INDENTED_CODE_PATTERN.test(line)) {
      markdown.push(line)
      continue
    }

    const bareAttachment = attachmentFromLine(line)
    if (bareAttachment !== null) {
      flushMarkdown()
      segments.push({
        id: `attachment:${segments.length}`,
        kind: 'attachment',
        ...bareAttachment,
      })
      continue
    }

    if (!STANDALONE_VIDEO_TAG_PATTERN.test(line)) {
      markdown.push(line)
      continue
    }
    // A tag can span lines, so look ahead for its close — bounded.
    const lastCandidate =
      Math.min(index + VIDEO_TAG_MAX_LINES, lines.length) - 1
    let cursor = index
    while (
      cursor < lastCandidate &&
      !VIDEO_TAG_END_PATTERN.test(lines[cursor] ?? '')
    ) {
      cursor += 1
    }
    const source = VIDEO_TAG_END_PATTERN.test(lines[cursor] ?? '')
      ? VIDEO_TAG_SRC_PATTERN.exec(
          lines.slice(index, cursor + 1).join('\n')
        )?.[1]
      : undefined
    if (source !== undefined && isWebUrl(source)) {
      flushMarkdown()
      segments.push({
        id: `attachment:${segments.length}`,
        kind: 'attachment',
        url: source,
        // The author wrote the tag, so this one is a video whatever the URL.
        media: 'video',
      })
      index = cursor
    } else {
      // Unclosed, or nothing linkable in it: prose.
      markdown.push(line)
    }
  }

  flushMarkdown()
  return segments
}
