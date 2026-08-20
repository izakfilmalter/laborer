import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import type { AgentProvider } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@laborer/ui/components/dialog'
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldSet,
} from '@laborer/ui/components/field'
import { Input } from '@laborer/ui/components/input'
import { ScrollArea } from '@laborer/ui/components/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@laborer/ui/components/select'
import { Spinner } from '@laborer/ui/components/spinner'
import { useLiveQuery } from '@tanstack/react-db'
import { Check, ExternalLink, Github, Loader2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { AGENT_ICONS } from '@/components/agent-icons'
import { useAppSettings } from '@/components/app-settings-context'
import { KeyboardShortcutsSection } from '@/components/keyboard-shortcuts-section'
import { LabelSettingsSection } from '@/components/labels/label-settings-section'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { setSetting as setSettingOptimistically } from '@/db/shared-mutations'
import { settingCollection } from '@/db/shared-state'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { extractErrorMessage } from '@/lib/errors'
import { parseGithubOAuthCallback } from '@/lib/github-oauth-callback'
import { localApi } from '@/lib/local-api'
import { toast } from '@/lib/toast'

const AGENT_OPTIONS: ReadonlyArray<{
  readonly label: string
  readonly value: AgentProvider
}> = [
  { label: 'OpenCode 2', value: 'opencode2' },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
]

const GITHUB_OAUTH_SCOPES = 'repo user workflow'
const GITHUB_OAUTH_CLIENT_ID = '3a723b10ac5575cc5bb9'

const exchangeCodeMutation = LaborerClient.mutation('github.exchangeOAuthCode')
const setAppSettingMutation = LaborerClient.mutation('appSetting.set')
const updateGlobalConfigMutation = LaborerClient.mutation('globalConfig.update')
const globalConfigGet$ = LaborerClient.query(
  'globalConfig.get',
  // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
  undefined as void
)

function GlobalConfigInitializer({
  onResolved,
}: {
  readonly onResolved: (config: { readonly agent?: string | undefined }) => void
}) {
  const globalConfigResult = useAtomValue(globalConfigGet$)

  useEffect(() => {
    if (globalConfigResult._tag !== 'Success') {
      return
    }

    onResolved(globalConfigResult.value)
  }, [globalConfigResult, onResolved])

  return null
}

export function AppSettingsModal() {
  const { open, onOpenChange } = useAppSettings()
  const { data: settings } = useLiveQuery((query) =>
    query.from({ settings: settingCollection })
  )
  const exchangeCode = useAtomSet(exchangeCodeMutation, { mode: 'promise' })
  const setAppSetting = useAtomSet(setAppSettingMutation, { mode: 'promise' })
  const updateGlobalConfig = useAtomSet(updateGlobalConfigMutation, {
    mode: 'promise',
  })
  const isEventuallyReady = useWhenPhase(LifecyclePhase.Eventually)

  const githubToken = settings.find((s) => s.key === 'github_desktop_token')
  const hasToken = Boolean(githubToken?.value)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [isExchanging, setIsExchanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const csrfStateRef = useRef<string>('')

  const [agent, setAgent] = useState<AgentProvider>('opencode2')
  const [agentInitialized, setAgentInitialized] = useState(false)
  const [isSavingAgent, setIsSavingAgent] = useState(false)

  const handleGlobalConfigResolved = useCallback(
    (config: { readonly agent?: string | undefined }) => {
      if (agentInitialized) {
        return
      }

      setAgent((config.agent as AgentProvider | undefined) ?? 'opencode2')
      setAgentInitialized(true)
    },
    [agentInitialized]
  )

  useEffect(() => {
    if (!open) {
      return
    }

    if (!isEventuallyReady) {
      setAgentInitialized(false)
    }
  }, [open, isEventuallyReady])

  const handleSaveAgent = useCallback(async () => {
    setIsSavingAgent(true)
    try {
      await updateGlobalConfig({
        payload: {
          config: { agent },
        },
      })
      toast.success('Saved default agent')
    } catch (err: unknown) {
      toast.error(extractErrorMessage(err))
    } finally {
      setIsSavingAgent(false)
    }
  }, [agent, updateGlobalConfig])

  const handleExchangeFromUrl = useCallback(
    async (url: string) => {
      setError(null)
      setIsExchanging(true)

      try {
        const code = parseGithubOAuthCallback(url, csrfStateRef.current)
        // Consume the one-time state before doing asynchronous work so a
        // duplicated protocol callback cannot start a second exchange.
        csrfStateRef.current = ''

        const result = await exchangeCode({ payload: { code } })

        await setSettingOptimistically({
          key: 'github_desktop_token',
          operationId: crypto.randomUUID(),
          send: (payload) => setAppSetting({ payload }),
          value: result.accessToken,
        })

        setCallbackUrl('')
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to exchange code.'
        )
      } finally {
        setIsExchanging(false)
      }
    },
    [exchangeCode, setAppSetting]
  )

  // Listen for the protocol handler callback (Electron only)
  useEffect(() => {
    const bridge = localApi.desktopBridge
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

    const bridge = localApi.desktopBridge
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
      await localApi.openExternal(url)
    }
  }, [])

  const handleSubmitUrl = useCallback(async () => {
    if (!callbackUrl.trim()) {
      return
    }
    await handleExchangeFromUrl(callbackUrl.trim())
  }, [callbackUrl, handleExchangeFromUrl])

  const handleDisconnect = useCallback(async () => {
    if (githubToken === undefined) {
      return
    }
    setError(null)
    try {
      await setSettingOptimistically({
        key: githubToken.key,
        operationId: crypto.randomUUID(),
        send: (payload) => setAppSetting({ payload }),
        value: '',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.')
    }
  }, [githubToken, setAppSetting])

  // Reset state when modal closes
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setCallbackUrl('')
        setError(null)
        setIsExchanging(false)
        setAgentInitialized(false)
        csrfStateRef.current = ''
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const statusLabel = useMemo(() => {
    return hasToken ? 'connected' : 'not connected'
  }, [hasToken])

  const AgentIcon =
    agent in AGENT_ICONS ? AGENT_ICONS[agent] : AGENT_ICONS.opencode2

  const isLoadingAgent = open && !agentInitialized

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className="max-h-[85svh] sm:max-w-2xl"
        data-testid="app-settings"
      >
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Configure app-wide settings for laborer.
          </DialogDescription>
        </DialogHeader>

        {open && isEventuallyReady && (
          <GlobalConfigInitializer onResolved={handleGlobalConfigResolved} />
        )}

        {/* Constrained so the shortcut reference can't push the dialog past
            the viewport on short screens. */}
        <ScrollArea className="h-auto max-h-[60vh]" scrollbarGutter>
          <div className="space-y-6 py-2">
            {/* Default Agent Section */}
            <FieldSet>
              <Field>
                <FieldLabel>Default agent</FieldLabel>
                {isLoadingAgent ? (
                  <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
                    <Spinner className="size-4" />
                    Loading...
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <Select
                        onValueChange={(value) =>
                          setAgent(value as AgentProvider)
                        }
                        value={agent}
                      >
                        <SelectTrigger data-testid="default-agent-select">
                          <SelectValue>
                            <AgentIcon className="size-3.5" />
                            {AGENT_OPTIONS.find((o) => o.value === agent)
                              ?.label ?? agent}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {AGENT_OPTIONS.map((option) => {
                            const Icon = AGENT_ICONS[option.value]
                            return (
                              <SelectItem
                                data-testid={`default-agent-option-${option.value}`}
                                key={option.value}
                                value={option.value}
                              >
                                <Icon className="size-3.5" />
                                {option.label}
                              </SelectItem>
                            )
                          })}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      data-testid="save-default-agent"
                      disabled={isSavingAgent}
                      onClick={handleSaveAgent}
                      size="sm"
                      variant="outline"
                    >
                      {isSavingAgent && <Spinner className="size-3.5" />}
                      {isSavingAgent ? 'Saving...' : 'Save'}
                    </Button>
                  </div>
                )}
                <FieldDescription>
                  The CLI agent to use when opening new agent panels. Projects
                  can override this in their own laborer.json.
                </FieldDescription>
              </Field>
            </FieldSet>

            {/* Labels Section — app-wide, shared by every project */}
            <LabelSettingsSection />

            {/* GitHub Connection Section */}
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Github className="h-5 w-5" />
                <h3 className="font-medium text-sm">GitHub Connection</h3>
                <span
                  className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                    hasToken
                      ? 'bg-green-500/10 text-green-500'
                      : 'bg-muted text-muted-foreground'
                  }`}
                  data-testid="github-connection-status"
                >
                  {hasToken && <Check className="h-3 w-3" />}
                  {statusLabel}
                </span>
              </div>

              <p className="text-muted-foreground text-sm">
                Connect your GitHub account to enable real-time PR status
                updates and other live notifications.
              </p>

              {hasToken ? (
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">
                    GitHub account connected.
                  </span>
                  <Button
                    onClick={handleDisconnect}
                    size="sm"
                    variant="outline"
                  >
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
                    <FieldLabel htmlFor="github-callback-url">
                      Callback URL (if needed)
                    </FieldLabel>
                    <div className="flex gap-2">
                      <Input
                        data-testid="github-callback-url"
                        id="github-callback-url"
                        onChange={(e) => setCallbackUrl(e.target.value)}
                        placeholder="x-github-desktop-dev-auth://oauth?code=..."
                        value={callbackUrl}
                      />
                      <Button
                        data-testid="submit-github-callback"
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
                </div>
              )}
              {error && (
                <p
                  className="text-destructive text-sm"
                  data-testid="github-connection-error"
                  role="alert"
                >
                  {error}
                </p>
              )}
            </div>

            {/* Keyboard Shortcuts Section */}
            <KeyboardShortcutsSection />
          </div>
        </ScrollArea>

        <DialogFooter />
      </DialogContent>
    </Dialog>
  )
}
