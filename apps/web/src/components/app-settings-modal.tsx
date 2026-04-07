import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { appSettings, events } from '@laborer/shared/schema'
import { queryDb } from '@livestore/livestore'
import {
  Check,
  Cloud,
  Container,
  ExternalLink,
  Github,
  Loader2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { AGENT_ICONS } from '@/components/agent-icons'
import { useAppSettings } from '@/components/app-settings-context'
import { getDesktopBridge, openExternalUrl } from '@/lib/desktop'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'
import { useLaborerStore } from '@/livestore/store'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Field, FieldDescription, FieldLabel, FieldSet } from './ui/field'
import { Input } from './ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'
import { Spinner } from './ui/spinner'

type AgentProvider = 'opencode' | 'claude' | 'codex'

const AGENT_OPTIONS: ReadonlyArray<{
  readonly label: string
  readonly value: AgentProvider
}> = [
  { label: 'OpenCode', value: 'opencode' },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
]

type SandboxProvider = 'docker' | 'daytona'

const SANDBOX_PROVIDER_OPTIONS: ReadonlyArray<{
  readonly label: string
  readonly value: SandboxProvider
  readonly description: string
  readonly Icon: typeof Container
}> = [
  {
    label: 'Docker',
    value: 'docker',
    description: 'Local containers via OrbStack',
    Icon: Container,
  },
  {
    label: 'Daytona',
    value: 'daytona',
    description: 'Cloud sandboxes',
    Icon: Cloud,
  },
]

/** Sub-component extracted to reduce AppSettingsModal complexity. */
function SandboxProviderSetting({
  isLoading,
  initialProvider,
  onSave,
}: {
  isLoading: boolean
  initialProvider: SandboxProvider
  onSave: (provider: SandboxProvider) => Promise<void>
}) {
  const [sandboxProvider, setSandboxProvider] =
    useState<SandboxProvider>(initialProvider)
  const [isSaving, setIsSaving] = useState(false)

  // Sync when the parent re-initializes after modal reopen
  useEffect(() => {
    setSandboxProvider(initialProvider)
  }, [initialProvider])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      await onSave(sandboxProvider)
      toast.success('Saved default sandbox provider')
    } catch (err: unknown) {
      toast.error(extractErrorMessage(err))
    } finally {
      setIsSaving(false)
    }
  }, [sandboxProvider, onSave])

  return (
    <FieldSet>
      <Field>
        <FieldLabel>Default sandbox provider</FieldLabel>
        {isLoading ? (
          <div className="flex items-center gap-2 py-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Loading...
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Select
                onValueChange={(value) =>
                  setSandboxProvider(value as SandboxProvider)
                }
                value={sandboxProvider}
              >
                <SelectTrigger>
                  <SelectValue>
                    {SANDBOX_PROVIDER_OPTIONS.find(
                      (o) => o.value === sandboxProvider
                    )?.label ?? sandboxProvider}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SANDBOX_PROVIDER_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      <option.Icon className="size-3.5" />
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              disabled={isSaving}
              onClick={handleSave}
              size="sm"
              variant="outline"
            >
              {isSaving && <Spinner className="size-3.5" />}
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
        <FieldDescription>
          Where new workspaces run by default. Docker uses local containers via
          OrbStack, Daytona uses cloud sandboxes. Projects can override this in
          their laborer.json.
        </FieldDescription>
      </Field>
    </FieldSet>
  )
}

const GITHUB_OAUTH_SCOPES = 'repo user workflow'
const GITHUB_OAUTH_CLIENT_ID = '3a723b10ac5575cc5bb9'

/** LiveStore query for all app settings. */
const allAppSettings$ = queryDb(appSettings, {
  label: 'appSettings',
})

const exchangeCodeMutation = LaborerClient.mutation('github.exchangeOAuthCode')
const updateGlobalConfigMutation = LaborerClient.mutation('globalConfig.update')

export function AppSettingsModal() {
  const { open, onOpenChange } = useAppSettings()
  const store = useLaborerStore()
  const settings = store.useQuery(allAppSettings$)
  const exchangeCode = useAtomSet(exchangeCodeMutation, { mode: 'promise' })

  const globalConfigGet$ = useMemo(
    // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
    () => LaborerClient.query('globalConfig.get', undefined as void),
    []
  )
  const globalConfigResult = useAtomValue(globalConfigGet$)
  const updateGlobalConfig = useAtomSet(updateGlobalConfigMutation, {
    mode: 'promise',
  })

  const githubToken = settings.find((s) => s.key === 'github_desktop_token')
  const hasToken = Boolean(githubToken?.value)
  const [callbackUrl, setCallbackUrl] = useState('')
  const [isExchanging, setIsExchanging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const csrfStateRef = useRef<string>('')

  const [agent, setAgent] = useState<AgentProvider>('opencode')
  const [resolvedProvider, setResolvedProvider] =
    useState<SandboxProvider>('docker')
  const [agentInitialized, setAgentInitialized] = useState(false)
  const [isSavingAgent, setIsSavingAgent] = useState(false)

  useEffect(() => {
    if (globalConfigResult._tag !== 'Success' || agentInitialized) {
      return
    }

    setAgent(globalConfigResult.value.agent ?? 'opencode')
    setResolvedProvider(
      (globalConfigResult.value.defaultSandboxProvider as
        | SandboxProvider
        | undefined) ?? 'docker'
    )
    setAgentInitialized(true)
  }, [globalConfigResult, agentInitialized])

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

  const handleSaveProvider = useCallback(
    async (provider: SandboxProvider) => {
      await updateGlobalConfig({
        payload: {
          config: { defaultSandboxProvider: provider },
        },
      })
      setResolvedProvider(provider)
    },
    [updateGlobalConfig]
  )

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
        setAgentInitialized(false)
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

  const AgentIcon =
    agent in AGENT_ICONS ? AGENT_ICONS[agent] : AGENT_ICONS.opencode

  const isLoadingAgent =
    globalConfigResult._tag !== 'Success' &&
    (globalConfigResult._tag === 'Initial' || globalConfigResult.waiting)

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
                      <SelectTrigger>
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
                            <SelectItem key={option.value} value={option.value}>
                              <Icon className="size-3.5" />
                              {option.label}
                            </SelectItem>
                          )
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
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
                The CLI agent to use when opening new agent panels. Projects can
                override this in their own laborer.json.
              </FieldDescription>
            </Field>
          </FieldSet>

          {/* Default Sandbox Provider Section */}
          <SandboxProviderSetting
            initialProvider={resolvedProvider}
            isLoading={isLoadingAgent}
            onSave={handleSaveProvider}
          />

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

        <DialogFooter />
      </DialogContent>
    </Dialog>
  )
}
