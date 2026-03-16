/**
 * Probe test: Can we access GitHub's Alive WebSocket service using a `gh` CLI token?
 *
 * This test calls the two internal GitHub API endpoints that GitHub Desktop uses
 * to connect to the Alive real-time notification service, using the token from
 * `gh auth token`. If these endpoints respond successfully, we can build a
 * real-time PR status update system on top of Alive instead of polling.
 *
 * Endpoints tested:
 * 1. GET /alive_internal/websocket-url  — returns the wss:// URL for Alive
 * 2. GET /desktop_internal/alive-channel — returns a signed channel subscription
 *
 * Run with: bun vitest run test/alive-probe.test.ts
 */

import { execSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const getGhToken = (): string => {
  const token = execSync('gh auth token', { encoding: 'utf-8' }).trim()
  if (!token) {
    throw new Error('No gh auth token found. Run `gh auth login` first.')
  }
  return token
}

/** Fetch helper that mimics GitHub Desktop's exact request headers */
const desktopApiFetch = async (
  path: string,
  token: string
): Promise<{
  status: number
  body: unknown
  headers: Record<string, string>
}> => {
  const url = `https://api.github.com${path}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json, application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'GitHubDesktop/3.4.12 (Macintosh)',
      Authorization: `Bearer ${token}`,
    },
  })

  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    headers[key] = value
  })

  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }

  return { status: res.status, body, headers }
}

describe('GitHub Alive probe', () => {
  const token = getGhToken()

  it('GET /alive_internal/websocket-url — probe endpoint', async () => {
    const result = await desktopApiFetch('/alive_internal/websocket-url', token)

    console.log('[alive-probe] websocket-url status:', result.status)
    console.log(
      '[alive-probe] websocket-url body:',
      JSON.stringify(result.body, null, 2)
    )

    // We just want to see what happens — any response is informative
    expect([200, 404, 401, 403]).toContain(result.status)
  })

  it('GET /desktop_internal/alive-channel — probe endpoint', async () => {
    const result = await desktopApiFetch(
      '/desktop_internal/alive-channel',
      token
    )

    console.log('[alive-probe] alive-channel status:', result.status)
    console.log(
      '[alive-probe] alive-channel body:',
      JSON.stringify(result.body, null, 2)
    )

    expect([200, 404, 401, 403]).toContain(result.status)
  })

  it('GET /alive_internal/token — probe for token endpoint', async () => {
    const result = await desktopApiFetch('/alive_internal/token', token)

    console.log('[alive-probe] alive token status:', result.status)
    console.log(
      '[alive-probe] alive token body:',
      JSON.stringify(result.body, null, 2)
    )

    expect([200, 404, 401, 403]).toContain(result.status)
  })

  it('probe with github.com base URL instead of api.github.com', async () => {
    // Desktop's API class uses api.github.com for dotcom, but maybe
    // the internal endpoints are routed differently
    const paths = [
      '/alive_internal/websocket-url',
      '/desktop_internal/alive-channel',
    ]

    for (const path of paths) {
      const url = `https://github.com${path}`
      const res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.v3+json, application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'GitHubDesktop/3.4.12 (Macintosh)',
          Authorization: `Bearer ${token}`,
        },
        redirect: 'manual',
      })

      console.log(`[alive-probe] github.com${path} status:`, res.status)
      const text = await res.text()
      try {
        console.log(
          `[alive-probe] github.com${path} body:`,
          JSON.stringify(JSON.parse(text), null, 2)
        )
      } catch {
        console.log(
          `[alive-probe] github.com${path} body (text):`,
          text.slice(0, 200)
        )
      }
    }
  })

  it('probe token type — check if gh token is OAuth vs PAT', async () => {
    // Check what the gh token looks like and what scopes it reports
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github.v3+json, application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'GitHubDesktop/3.4.12 (Macintosh)',
        Authorization: `Bearer ${token}`,
      },
    })

    const scopes = res.headers.get('x-oauth-scopes')
    const tokenPrefix = token.slice(0, 4)
    const tokenTypeMap: Record<string, string> = {
      gho_: 'OAuth App token',
      ghp_: 'Personal Access Token',
      ghs_: 'GitHub App installation token',
    }
    const tokenType =
      tokenTypeMap[tokenPrefix] ?? `unknown (prefix: ${tokenPrefix})`

    console.log('[alive-probe] Token type:', tokenType)
    console.log('[alive-probe] Token scopes:', scopes)
    console.log('[alive-probe] /user status:', res.status)

    const user = await res.json()
    console.log(
      '[alive-probe] Authenticated as:',
      (user as { login?: string }).login
    )
  })

  it('try direct WebSocket to alive.github.com', async () => {
    // Maybe we can connect directly without the internal endpoint
    // The URL format from Desktop is wss://alive.github.com/u/{userId}/ws
    // First get our user ID
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    })
    const user = (await userRes.json()) as { id?: number; login?: string }
    console.log('[alive-probe] User ID:', user.id, 'Login:', user.login)

    if (!user.id) {
      console.log('[alive-probe] Could not get user ID')
      return
    }

    // Try constructing the WebSocket URL directly
    const wsUrl = `wss://alive.github.com/u/${user.id}/ws`
    console.log('[alive-probe] Trying direct WebSocket URL:', wsUrl)

    const ws = new WebSocket(wsUrl)
    const wsEvents: string[] = []

    const result = await new Promise<{
      opened: boolean
      error?: string
    }>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ opened: false, error: 'timeout after 5s' })
      }, 5000)

      ws.addEventListener('open', () => {
        wsEvents.push('open')
        console.log('[alive-probe] Direct WS OPENED!')
        clearTimeout(timeout)
        setTimeout(() => {
          ws.close()
          resolve({ opened: true })
        }, 1000)
      })

      ws.addEventListener('message', (event) => {
        wsEvents.push(`message: ${String(event.data)}`)
        console.log('[alive-probe] Direct WS message:', String(event.data))
      })

      ws.addEventListener('error', (event) => {
        wsEvents.push(`error: ${String(event)}`)
        console.log('[alive-probe] Direct WS error:', event)
        clearTimeout(timeout)
        resolve({ opened: false, error: String(event) })
      })

      ws.addEventListener('close', (event) => {
        wsEvents.push(`close: code=${event.code} reason=${event.reason}`)
        console.log('[alive-probe] Direct WS closed:', event.code, event.reason)
      })
    })

    console.log('[alive-probe] Direct WS events:', wsEvents)
    console.log('[alive-probe] Direct WS result:', result)
  }, 10_000)

  it('WebSocket connection test (if websocket-url accessible)', async () => {
    const urlResult = await desktopApiFetch(
      '/alive_internal/websocket-url',
      token
    )

    if (urlResult.status !== 200) {
      console.log(
        '[alive-probe] Skipping WebSocket test — websocket-url returned',
        urlResult.status
      )
      return
    }

    const wsUrl = (urlResult.body as { url?: string })?.url
    if (!wsUrl) {
      console.log('[alive-probe] No WebSocket URL in response body')
      return
    }

    console.log('[alive-probe] WebSocket URL:', wsUrl)
    const ws = new WebSocket(wsUrl)
    const wsEvents: string[] = []

    const result = await new Promise<{
      opened: boolean
      error?: string
    }>((resolve) => {
      const timeout = setTimeout(() => {
        ws.close()
        resolve({ opened: false, error: 'timeout after 5s' })
      }, 5000)

      ws.addEventListener('open', () => {
        wsEvents.push('open')
        console.log('[alive-probe] WebSocket OPENED successfully!')
        clearTimeout(timeout)
        setTimeout(() => {
          ws.close()
          resolve({ opened: true })
        }, 1000)
      })

      ws.addEventListener('message', (event) => {
        wsEvents.push(`message: ${String(event.data)}`)
        console.log('[alive-probe] WebSocket message:', String(event.data))
      })

      ws.addEventListener('error', (event) => {
        wsEvents.push(`error: ${String(event)}`)
        console.log('[alive-probe] WebSocket error:', event)
        clearTimeout(timeout)
        resolve({ opened: false, error: String(event) })
      })

      ws.addEventListener('close', (event) => {
        wsEvents.push(`close: code=${event.code} reason=${event.reason}`)
        console.log('[alive-probe] WebSocket closed:', event.code, event.reason)
      })
    })

    console.log('[alive-probe] WebSocket events:', wsEvents)
    console.log('[alive-probe] Connection result:', result)
  }, 10_000)

  it('full AliveSession subscribe (if both endpoints accessible)', async () => {
    const [urlResult, channelResult] = await Promise.all([
      desktopApiFetch('/alive_internal/websocket-url', token),
      desktopApiFetch('/desktop_internal/alive-channel', token),
    ])

    if (urlResult.status !== 200 || channelResult.status !== 200) {
      console.log(
        '[alive-probe] Skipping AliveSession test — endpoints not accessible'
      )
      console.log('  websocket-url:', urlResult.status)
      console.log('  alive-channel:', channelResult.status)
      return
    }

    const wsUrl = (urlResult.body as { url?: string })?.url
    const channelInfo = channelResult.body as {
      channel_name?: string
      signed_channel?: string
    }

    if (!(wsUrl && channelInfo.channel_name && channelInfo.signed_channel)) {
      console.log('[alive-probe] Missing required data for AliveSession')
      return
    }

    console.log('[alive-probe] Channel name:', channelInfo.channel_name)
    console.log(
      '[alive-probe] Signed channel:',
      channelInfo.signed_channel.slice(0, 50),
      '...'
    )

    const { AliveSession } = await import('@github/alive-client')

    const receivedEvents: unknown[] = []
    const notify = (_subscribers: Iterable<unknown>, event: unknown): void => {
      receivedEvents.push(event)
      console.log(
        '[alive-probe] AliveSession event:',
        JSON.stringify(event, null, 2)
      )
    }

    const session = new AliveSession(
      wsUrl,
      () =>
        desktopApiFetch('/alive_internal/websocket-url', token).then(
          (r) => (r.body as { url?: string })?.url ?? null
        ),
      false,
      notify
    )

    const subscription = {
      subscriber: 'probe-test',
      topic: {
        name: channelInfo.channel_name,
        signed: channelInfo.signed_channel,
        offset: '',
      },
    }

    session.subscribe([subscription])

    // Wait a few seconds to observe any events
    await new Promise((resolve) => setTimeout(resolve, 5000))

    console.log('[alive-probe] Total events received:', receivedEvents.length)
    console.log(
      '[alive-probe] Events:',
      JSON.stringify(receivedEvents, null, 2)
    )

    session.offline()
  }, 15_000)
})
