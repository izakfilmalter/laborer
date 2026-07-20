/**
 * Test: Connect to GitHub Alive using a Desktop-issued OAuth token.
 *
 * Runs in jsdom environment so `self`, `location`, and `WebSocket` are
 * available — matching the browser context where alive-client normally runs.
 *
 * Prerequisites: Run the OAuth flow manually to get a token:
 *   1. Open: https://github.com/login/oauth/authorize?client_id=3a723b10ac5575cc5bb9&scope=repo%20user%20workflow&state=test
 *   2. Authorize -> browser redirects to x-github-desktop-dev-auth://oauth?code=XXX&state=test
 *   3. Exchange the code:
 *      curl -s -X POST 'https://github.com/login/oauth/access_token' \
 *        -H 'Accept: application/json' -H 'Content-Type: application/json' \
 *        -d '{"client_id":"3a723b10ac5575cc5bb9","client_secret":"22c34d87789a365981ed921352a7b9a8c3f69d54","code":"XXX"}'
 *   4. Set DESKTOP_TOKEN env var to the access_token value
 *
 * Run with: DESKTOP_TOKEN=gho_xxx bun vitest run test/alive-desktop-oauth.test.ts
 */

import { describe, expect, it } from 'vitest'

const DESKTOP_TOKEN = process.env.DESKTOP_TOKEN ?? ''

/** Mimic Desktop's exact headers for API requests */
const desktopFetch = async (
  url: string,
  token: string,
  method = 'GET',
  body?: unknown
): Promise<{ status: number; body: unknown }> => {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json, application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'GitHubDesktop/3.4.12 (Macintosh)',
    Authorization: `Bearer ${token}`,
  }

  const init: RequestInit = { method, headers }
  if (body) {
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)

  const text = await res.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }

  return { status: res.status, body: parsed }
}

describe('GitHub Alive with Desktop OAuth token', () => {
  it.skipIf(!DESKTOP_TOKEN)(
    'connects to Alive and subscribes to desktop channel',
    async () => {
      // Verify the token works
      const userResult = await desktopFetch(
        'https://api.github.com/user',
        DESKTOP_TOKEN
      )
      expect(userResult.status).toBe(200)
      const user = userResult.body as { login: string; id: number }
      console.log('[alive] Authenticated as:', user.login, '(id:', user.id, ')')

      // Get WebSocket URL
      const wsUrlResult = await desktopFetch(
        'https://api.github.com/alive_internal/websocket-url',
        DESKTOP_TOKEN
      )
      console.log('[alive] websocket-url status:', wsUrlResult.status)
      expect(wsUrlResult.status).toBe(200)

      const wsUrl = (wsUrlResult.body as { url: string }).url
      console.log('[alive] WebSocket URL:', wsUrl)

      // Get signed channel
      const channelResult = await desktopFetch(
        'https://api.github.com/desktop_internal/alive-channel',
        DESKTOP_TOKEN
      )
      console.log('[alive] alive-channel status:', channelResult.status)
      expect(channelResult.status).toBe(200)

      const channelInfo = channelResult.body as {
        channel_name: string
        signed_channel: string
      }
      console.log('[alive] Channel:', channelInfo.channel_name)

      // Connect with AliveSession
      const { AliveSession } = await import('@github/alive-client')

      const receivedEvents: unknown[] = []
      const notify = (
        _subscribers: Iterable<unknown>,
        event: unknown
      ): void => {
        receivedEvents.push(event)
        console.log('[alive] EVENT RECEIVED:', JSON.stringify(event, null, 2))
      }

      const session = new AliveSession(
        wsUrl,
        async () => {
          const r = await desktopFetch(
            'https://api.github.com/alive_internal/websocket-url',
            DESKTOP_TOKEN
          )
          return (r.body as { url?: string })?.url ?? null
        },
        false,
        notify
      )

      session.subscribe([
        {
          subscriber: 'laborer-test',
          topic: {
            name: channelInfo.channel_name,
            signed: channelInfo.signed_channel,
            offset: '',
          },
        },
      ])

      console.log(
        '[alive] Connected and subscribed! Listening for 15 seconds...'
      )
      console.log('[alive] (Try merging/commenting on a PR to trigger events)')

      await new Promise((resolve) => setTimeout(resolve, 15_000))

      console.log('[alive] Total events received:', receivedEvents.length)
      if (receivedEvents.length > 0) {
        console.log('[alive] Events:', JSON.stringify(receivedEvents, null, 2))
      }

      session.offline()
      console.log('[alive] Session closed cleanly.')
    },
    30_000
  )
})
