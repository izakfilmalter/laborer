/**
 * React hook that connects to GitHub's Alive WebSocket service using a
 * Desktop-issued OAuth token stored in LiveStore. When events arrive
 * (pr-comment, pr-review-submit, pr-checks-failed), it fires callbacks
 * so consumers can trigger immediate data refreshes instead of polling.
 *
 * The connection is established when a valid `github_desktop_token` exists
 * in the `app_settings` LiveStore table, and torn down when the token is
 * removed or the component unmounts.
 */

import type { AliveEvent, Notifier } from '@github/alive-client'
import { appSettings } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { useCallback, useEffect, useRef } from 'react'
import { useLaborerStore } from '@/livestore/store'

// ---------------------------------------------------------------------------
// Alive event types (matching GitHub Desktop's event shapes)
// ---------------------------------------------------------------------------

interface PrChecksFailedEvent {
  readonly check_suite_id: number
  readonly commit_sha: string
  readonly owner: string
  readonly pull_request_number: number
  readonly repo: string
  readonly timestamp: number
  readonly type: 'pr-checks-failed'
}

interface PrReviewSubmitEvent {
  readonly owner: string
  readonly pull_request_number: number
  readonly repo: string
  readonly review_id: string
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  readonly timestamp: number
  readonly type: 'pr-review-submit'
}

interface PrCommentEvent {
  readonly comment_id: string
  readonly owner: string
  readonly pull_request_number: number
  readonly repo: string
  readonly subtype: 'review-comment' | 'issue-comment'
  readonly timestamp: number
  readonly type: 'pr-comment'
}

export type GitHubAliveEvent =
  | PrChecksFailedEvent
  | PrCommentEvent
  | PrReviewSubmitEvent

// ---------------------------------------------------------------------------
// GitHub API helpers (Desktop-style headers)
// ---------------------------------------------------------------------------

async function desktopApiFetch(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github.v3+json, application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'GitHubDesktop/3.4.12 (Macintosh)',
      Authorization: `Bearer ${token}`,
    },
  })
  if (!res.ok) {
    return null
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// LiveStore query
// ---------------------------------------------------------------------------

const allAppSettings$ = queryDb(appSettings, { label: 'aliveAppSettings' })

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Connects to GitHub Alive and calls `onEvent` for each incoming event.
 * The connection lifecycle is managed automatically based on whether a
 * `github_desktop_token` exists in LiveStore.
 */
export function useAliveEvents(
  onEvent: (event: GitHubAliveEvent) => void
): void {
  const store = useLaborerStore()
  const settings = store.useQuery(allAppSettings$)
  const githubToken =
    settings.find((s) => s.key === 'github_desktop_token')?.value ?? ''

  // Keep the callback ref stable so we don't reconnect on every render.
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent

  // Track the AliveSession so we can tear it down.
  const sessionRef = useRef<{ offline: () => void } | null>(null)
  const connectedTokenRef = useRef<string>('')

  const connect = useCallback(async (token: string) => {
    // Tear down any existing session first.
    if (sessionRef.current) {
      sessionRef.current.offline()
      sessionRef.current = null
    }
    connectedTokenRef.current = ''

    if (!token) {
      return
    }

    try {
      // Fetch WebSocket URL and signed channel in parallel.
      const [wsUrlData, channelData] = await Promise.all([
        desktopApiFetch('/alive_internal/websocket-url', token),
        desktopApiFetch('/desktop_internal/alive-channel', token),
      ])

      const wsUrl = (wsUrlData as { url?: string })?.url
      const channelInfo = channelData as {
        channel_name?: string
        signed_channel?: string
      }

      if (
        !(wsUrl && channelInfo?.channel_name && channelInfo?.signed_channel)
      ) {
        console.warn('[Alive] Failed to get WebSocket URL or channel info')
        return
      }

      const { AliveSession } = await import('@github/alive-client')

      const notify: Notifier<string> = (_subscribers, event: AliveEvent) => {
        if (event.type !== 'message') {
          return
        }
        // The event.data from Alive messages is the raw payload.
        // For Desktop channel events, the data object contains the event type.
        const data = event.data as unknown as { type?: string }
        if (!data?.type) {
          return
        }
        const knownTypes = [
          'pr-checks-failed',
          'pr-review-submit',
          'pr-comment',
        ]
        if (knownTypes.includes(data.type)) {
          onEventRef.current(data as unknown as GitHubAliveEvent)
        }
      }

      const session = new AliveSession(
        wsUrl,
        async () => {
          const r = await desktopApiFetch(
            '/alive_internal/websocket-url',
            token
          )
          return (r as { url?: string })?.url ?? null
        },
        false,
        notify
      )

      session.subscribe([
        {
          subscriber: 'laborer',
          topic: {
            name: channelInfo.channel_name,
            signed: channelInfo.signed_channel,
            offset: '',
          },
        },
      ])

      sessionRef.current = session
      connectedTokenRef.current = token
      console.log('[Alive] Connected to', channelInfo.channel_name)
    } catch (err) {
      console.warn('[Alive] Connection failed:', err)
    }
  }, [])

  // Connect/disconnect when token changes.
  useEffect(() => {
    if (githubToken && githubToken !== connectedTokenRef.current) {
      connect(githubToken)
    } else if (!githubToken && sessionRef.current) {
      sessionRef.current.offline()
      sessionRef.current = null
      connectedTokenRef.current = ''
    }

    return () => {
      if (sessionRef.current) {
        sessionRef.current.offline()
        sessionRef.current = null
        connectedTokenRef.current = ''
      }
    }
  }, [githubToken, connect])
}
