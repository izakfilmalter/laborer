import type { DiscoveredLocalServer } from '@laborer/shared/rpc'

export interface PreviewableServer extends DiscoveredLocalServer {
  readonly requestedUrl: string
  readonly source: 'configured' | 'scanner'
}

const isLoopback = (host: string): boolean =>
  host === 'localhost' ||
  host === '0.0.0.0' ||
  host === '127.0.0.1' ||
  host === '::1'

const key = (host: string, port: number): string =>
  `${isLoopback(host.toLowerCase()) ? 'loopback' : host.toLowerCase()}:${String(port)}`

const configuredServer = (raw: string) => {
  try {
    const url = new URL(raw)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !isLoopback(url.hostname.toLowerCase())
    ) {
      return null
    }
    let port = url.protocol === 'http:' ? 80 : 443
    if (url.port) {
      port = Number.parseInt(url.port, 10)
    }
    return { key: key(url.hostname, port), url: url.href }
  } catch {
    return null
  }
}

/** t3 ordering: configured live servers first, then scanner-only, each by port. */
export function mergePreviewServers(
  scanner: readonly DiscoveredLocalServer[],
  configuredUrls: readonly string[]
): readonly PreviewableServer[] {
  const configured = new Map<string, string>()
  for (const raw of configuredUrls) {
    const parsed = configuredServer(raw)
    if (parsed && !configured.has(parsed.key)) {
      configured.set(parsed.key, parsed.url)
    }
  }
  return scanner
    .map((server): PreviewableServer => {
      const requestedUrl = configured.get(key(server.host, server.port))
      return {
        ...server,
        requestedUrl: requestedUrl ?? server.url,
        source: requestedUrl === undefined ? 'scanner' : 'configured',
      }
    })
    .toSorted((left, right) => {
      if (left.source !== right.source) {
        return left.source === 'configured' ? -1 : 1
      }
      return left.port - right.port
    })
}
