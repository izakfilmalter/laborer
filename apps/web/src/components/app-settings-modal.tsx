import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { appSettings, events } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import { Check, ExternalLink, Github, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { getDesktopBridge, openExternalUrl } from '@/lib/desktop'
import { useLaborerStore } from '@/livestore/store'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Field, FieldDescription, FieldLabel } from './ui/field'
import { Input } from './ui/input'

const GITHUB_OAUTH_SCOPES = 'repo user workflow'
const GITHUB_OAUTH_CLIENT_ID = '3a723b10ac5575cc5bb9'

/** LiveStore query for all app settings. */
const allAppSettings$ = queryDb(appSettings, {
  label: 'appSettings',
})

const exchangeCodeMutation = LaborerClient.mutation('github.exchangeOAuthCode')

export function AppSettingsModal({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  const store = useLaborerStore()
  const settings = store.useQuery(allAppSettings$)
  const exchangeCode = useAtomSet(exchangeCodeMutation, { mode: 'promise' })

  const githubToken = settings.find((s) => s.key === 'github_desktop_token')
  const hasToken = Boolean(githubToken?.value)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [isExchanging, setIsExchanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const csrfStateRef = useRef<string>('')

  const handleExchangeFromUrl = useCallback(
    async (url: string) => {
      setError(null)
      setIsExchanging(true)

      try {
        const parsed = new URL(url)
        const code = parsed.searchParams.get('code')

        if (!code) {
          setError('No authorization code found in the URL.')
          setIsExchanging(false)
          return
        }

        const result = await exchangeCode({ payload: { code } })

        // Store the token in LiveStore
        store.commit(
          events.appSettingChanged({
            key: 'github_desktop_token',
            value: result.accessToken,
          })
        )

        setSuccess(true)
        setCallbackUrl('')
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to exchange code.'
        )
      } finally {
        setIsExchanging(false)
      }
    },
    [exchangeCode, store]
  )

  // Listen for the protocol handler callback (Electron only)
  useEffect(() => {
    const bridge = getDesktopBridge()
    if (!bridge?.onGithubOAuthCallback) {
      return
    }

    const unsubscribe = bridge.onGithubOAuthCallback((url) => {
      setCallbackUrl(url)
      // Auto-submit when the callback arrives via protocol handler
      handleExchangeFromUrl(url)
    })

    return unsubscribe
  }, [handleExchangeFromUrl])

  const handleStartOAuth = useCallback(async () => {
    const state = crypto.randomUUID()
    csrfStateRef.current = state
    setError(null)
    setSuccess(false)

    const bridge = getDesktopBridge()
    if (bridge?.startGithubOAuth) {
      // Electron: use the protocol handler to open the browser and
      // automatically capture the callback.
      await bridge.startGithubOAuth(state)
    } else {
      // Browser fallback: open the OAuth URL directly. The user will
      // need to manually paste the callback URL.
      const scope = encodeURIComponent(GITHUB_OAUTH_SCOPES)
      const url =
        'https://github.com/login/oauth/authorize' +
        `?client_id=${GITHUB_OAUTH_CLIENT_ID}` +
        `&scope=${scope}` +
        `&state=${state}`
      await openExternalUrl(url)
    }
  }, [])

  const handleSubmitUrl = useCallback(async () => {
    if (!callbackUrl.trim()) {
      return
    }
    await handleExchangeFromUrl(callbackUrl.trim())
  }, [callbackUrl, handleExchangeFromUrl])

  const handleDisconnect = useCallback(() => {
    store.commit(
      events.appSettingChanged({
        key: 'github_desktop_token',
        value: '',
      })
    )
    setSuccess(false)
  }, [store])

  // Reset state when modal closes
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setCallbackUrl('')
        setError(null)
        setIsExchanging(false)
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const statusLabel = useMemo(() => {
    if (success) {
      return 'connected'
    }
    return hasToken ? 'connected' : 'not connected'
  }, [hasToken, success])

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure app-wide settings for laborer.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* GitHub Connection Section */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Github className="h-5 w-5" />
              <h3 className="font-medium text-sm">GitHub Connection</h3>
              <span
                className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                  hasToken || success
                    ? 'bg-green-500/10 text-green-500'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {(hasToken || success) && <Check className="h-3 w-3" />}
                {statusLabel}
              </span>
            </div>

            <p className="text-muted-foreground text-sm">
              Connect your GitHub account to enable real-time PR status updates,
              review comments, and other live notifications.
            </p>

            {hasToken || success ? (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">
                  GitHub account connected.
                </span>
                <Button onClick={handleDisconnect} size="sm" variant="outline">
                  Disconnect
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Step 1: Start OAuth */}
                <Button
                  className="w-full"
                  onClick={handleStartOAuth}
                  variant="outline"
                >
                  <Github className="mr-2 h-4 w-4" />
                  Connect GitHub Account
                  <ExternalLink className="ml-2 h-3 w-3" />
                </Button>

                {/* Instructions */}
                <div className="rounded-md bg-muted p-3 text-sm">
                  <p className="font-medium">How it works:</p>
                  <ol className="mt-1 list-inside list-decimal space-y-1 text-muted-foreground">
                    <li>
                      Click the button above to open GitHub in your browser
                    </li>
                    <li>Authorize the application</li>
                    <li>
                      If the app doesn&apos;t auto-capture the callback, copy
                      the URL shown in your browser and paste it below
                    </li>
                  </ol>
                </div>

                {/* Step 2: Paste callback URL (fallback) */}
                <Field>
                  <FieldLabel>Callback URL (if needed)</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      onChange={(e) => setCallbackUrl(e.target.value)}
                      placeholder="x-github-desktop-dev-auth://oauth?code=..."
                      value={callbackUrl}
                    />
                    <Button
                      disabled={!callbackUrl.trim() || isExchanging}
                      onClick={handleSubmitUrl}
                      variant="default"
                    >
                      {isExchanging ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        'Connect'
                      )}
                    </Button>
                  </div>
                  <FieldDescription>
                    Paste the full URL from your browser after authorizing.
                  </FieldDescription>
                </Field>

                {error && <p className="text-destructive text-sm">{error}</p>}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
