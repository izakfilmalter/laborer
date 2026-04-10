/** biome-ignore-all lint: terminal link parsing is regex-heavy by design. */
export type TerminalLinkKind = 'path' | 'url'

export interface TerminalLinkMatch {
  readonly end: number
  readonly kind: TerminalLinkKind
  readonly start: number
  readonly text: string
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/g
const FILE_PATH_PATTERN =
  /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}/g
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/

const trimClosingDelimiters = (value: string): string => {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, '')
  if (output.length === 0) {
    return output
  }

  const trimUnbalanced = (open: string, close: string) => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1
      const closes = output.split(close).length - 1
      if (opens >= closes) {
        return
      }

      output = output.slice(0, -1)
    }
  }

  trimUnbalanced('(', ')')
  trimUnbalanced('[', ']')
  trimUnbalanced('{', '}')

  return output
}

const overlaps = (
  left: Pick<TerminalLinkMatch, 'end' | 'start'>,
  right: Pick<TerminalLinkMatch, 'end' | 'start'>
): boolean => left.start < right.end && right.start < left.end

const collectMatches = (
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: readonly TerminalLinkMatch[]
): TerminalLinkMatch[] => {
  const matches: TerminalLinkMatch[] = []
  pattern.lastIndex = 0

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch[0]
    const start = rawMatch.index ?? -1

    if (start < 0 || raw.length === 0) {
      continue
    }

    const trimmed = trimClosingDelimiters(raw)
    if (trimmed.length === 0) {
      continue
    }

    if (kind === 'path' && /^https?:\/\//i.test(trimmed)) {
      continue
    }

    const candidate: TerminalLinkMatch = {
      end: start + trimmed.length,
      kind,
      start,
      text: trimmed,
    }

    const collides = [...existing, ...matches].some((other) =>
      overlaps(candidate, other)
    )
    if (collides) {
      continue
    }

    matches.push(candidate)
  }

  return matches
}

const isWindowsAbsolutePath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')

const isAbsolutePath = (value: string): boolean =>
  value.startsWith('/') || isWindowsAbsolutePath(value)

const isWindowsPathStyle = (value: string): boolean =>
  isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value)

const joinPath = (
  base: string,
  next: string,
  separator: '/' | '\\'
): string => {
  const cleanBase = base.replace(/[\\/]+$/, '')

  if (separator === '\\') {
    return `${cleanBase}\\${next.replaceAll('/', '\\')}`
  }

  return `${cleanBase}/${next.replace(/^\/+/, '')}`
}

const inferHomeFromCwd = (cwd: string): string | undefined => {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/)
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/)
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/)
  if (windowsUser?.[1]) {
    return windowsUser[1]
  }

  return undefined
}

const splitPathAndPosition = (value: string) => {
  let targetPath = value
  let column: string | undefined
  let line: string | undefined

  const columnMatch = targetPath.match(/:(\d+)$/)
  if (!columnMatch?.[1]) {
    return { column, line, path: targetPath }
  }

  column = columnMatch[1]
  targetPath = targetPath.slice(0, -columnMatch[0].length)

  const lineMatch = targetPath.match(/:(\d+)$/)
  if (lineMatch?.[1]) {
    line = lineMatch[1]
    targetPath = targetPath.slice(0, -lineMatch[0].length)
  } else {
    line = column
    column = undefined
  }

  return { column, line, path: targetPath }
}

export const extractTerminalLinks = (line: string): TerminalLinkMatch[] => {
  const urlMatches = collectMatches(line, 'url', URL_PATTERN, [])
  const pathMatches = collectMatches(
    line,
    'path',
    FILE_PATH_PATTERN,
    urlMatches
  )

  return [...urlMatches, ...pathMatches].toSorted(
    (left, right) => left.start - right.start
  )
}

export const isTerminalLinkActivation = (
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
  platform = typeof navigator === 'undefined' ? '' : navigator.platform
): boolean => {
  if (platform.length === 0) {
    return false
  }

  const isMac = platform.toLowerCase().startsWith('mac')
  return isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

export const resolvePathLinkTarget = (rawPath: string, cwd: string): string => {
  const { column, line, path } = splitPathAndPosition(rawPath)

  let resolvedPath = path
  if (path.startsWith('~/')) {
    const home = inferHomeFromCwd(cwd)
    if (home) {
      const separator: '/' | '\\' = isWindowsPathStyle(home) ? '\\' : '/'
      resolvedPath = joinPath(home, path.slice(2), separator)
    }
  } else if (!isAbsolutePath(path)) {
    const separator: '/' | '\\' = isWindowsPathStyle(cwd) ? '\\' : '/'
    resolvedPath = joinPath(cwd, path, separator)
  }

  if (!line) {
    return resolvedPath
  }

  return `${resolvedPath}:${line}${column ? `:${column}` : ''}`
}
