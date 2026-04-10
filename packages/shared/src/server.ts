export const DEFAULT_SERVER_HOST = '127.0.0.1'
export const DEFAULT_SERVER_PORT = 2773
export const DEFAULT_WEB_PORT = 2001
export const SERVER_HEALTH_PATHNAME = '/health'
export const SERVER_WS_PATHNAME = '/ws'

const formatHost = (host: string): string =>
  host.includes(':') && !host.startsWith('[') ? `[${host}]` : host

export const resolveServerHttpUrl = (options?: {
  readonly host?: string
  readonly port?: number
  readonly pathname?: string
}): string => {
  const host = options?.host ?? DEFAULT_SERVER_HOST
  const port = options?.port ?? DEFAULT_SERVER_PORT
  const url = new URL(`http://${formatHost(host)}:${port}`)
  url.pathname = options?.pathname ?? '/'
  return url.toString()
}

export const resolveServerWsUrl = (options?: {
  readonly host?: string
  readonly port?: number
  readonly pathname?: string
}): string => {
  const url = new URL(
    resolveServerHttpUrl({
      host: options?.host,
      port: options?.port,
      pathname: options?.pathname ?? SERVER_WS_PATHNAME,
    })
  )
  url.protocol = 'ws:'
  return url.toString()
}
