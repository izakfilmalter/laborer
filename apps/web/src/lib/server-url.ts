import { resolveServerHttpUrl } from '@laborer/shared/server'

const firstNonEmptyString = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }

  throw new Error('No server URL is available.')
}

export const resolveServerUrl = (options?: {
  readonly pathname?: string
  readonly protocol?: 'http' | 'https' | 'ws' | 'wss'
  readonly searchParams?: Record<string, string>
  readonly url?: string
}): string => {
  const rawUrl = firstNonEmptyString(
    options?.url,
    window.desktopBridge?.getWsUrl(),
    import.meta.env.VITE_WS_URL,
    import.meta.env.DEV ? resolveServerHttpUrl() : undefined,
    window.location.origin
  )

  const parsedUrl = new URL(rawUrl)

  if (options?.protocol) {
    parsedUrl.protocol = options.protocol
  }

  parsedUrl.pathname = options?.pathname ?? '/'

  if (options?.searchParams) {
    parsedUrl.search = new URLSearchParams(options.searchParams).toString()
  }

  return parsedUrl.toString()
}
