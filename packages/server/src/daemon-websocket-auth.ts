import { Context, Schema } from 'effect'

const decodeString = Schema.decodeUnknownOption(Schema.String)

const decodeOrigin = (value: unknown) => {
  const decoded = decodeString(value)
  if (decoded._tag === 'None') {
    return decoded
  }
  try {
    const url = new URL(decoded.value)
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === decoded.value
      ? decoded
      : { _tag: 'None' as const }
  } catch {
    return { _tag: 'None' as const }
  }
}

export class DaemonWebSocketPolicyConfigError extends Schema.TaggedError<DaemonWebSocketPolicyConfigError>()(
  'DaemonWebSocketPolicyConfigError',
  { message: Schema.String }
) {}

export class DaemonWebSocketPolicy extends Context.Service<
  DaemonWebSocketPolicy,
  { readonly browserOrigins: ReadonlySet<string> }
>()('@laborer/server/DaemonWebSocketPolicy') {}

const validatedOrigin = (value: unknown, label: string): string => {
  const decoded = decodeOrigin(value)
  if (decoded._tag === 'None') {
    throw new DaemonWebSocketPolicyConfigError({
      message: `${label} must be an HTTP origin`,
    })
  }
  return decoded.value
}

export const makeDaemonWebSocketPolicy = (
  daemonOrigin: string,
  vitePort: string | undefined
): DaemonWebSocketPolicy['Service'] => {
  const browserOrigins = new Set([
    validatedOrigin(daemonOrigin, 'Daemon origin'),
  ])
  if (vitePort !== undefined && vitePort.trim() !== '') {
    const port = Schema.decodeUnknownOption(
      Schema.NumberFromString.check(
        Schema.isInt(),
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(65_535)
      )
    )(vitePort)
    if (port._tag === 'None') {
      throw new DaemonWebSocketPolicyConfigError({
        message: 'VITE_PORT must be an integer from 1 to 65535',
      })
    }
    browserOrigins.add(`http://localhost:${String(port.value)}`)
    browserOrigins.add(`http://127.0.0.1:${String(port.value)}`)
  }
  return DaemonWebSocketPolicy.of({ browserOrigins })
}

export const isDaemonWebSocketRequestAllowed = (
  policy: DaemonWebSocketPolicy['Service'],
  origin: unknown
): boolean => {
  // Browser WebSockets always carry Origin. Native Effect/CLI clients do not,
  // so absence is an intentional native transport capability rather than a
  // browser fallback; malformed and `null` browser origins remain denied.
  if (origin === undefined) {
    return true
  }
  const decoded = decodeOrigin(origin)
  return decoded._tag === 'Some' && policy.browserOrigins.has(decoded.value)
}
