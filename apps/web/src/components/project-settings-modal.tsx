import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { Plus, Settings, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'
import { AGENT_ICONS } from '@/components/agent-icons'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'
import {
  buildConfigUpdates,
  getSettingsLoadErrorMessage,
  type SetupScriptItem,
} from './project-settings-modal.helpers'

type AgentProvider = 'opencode' | 'claude' | 'codex'

const AGENT_OPTIONS: ReadonlyArray<{
  readonly label: string
  readonly value: AgentProvider
}> = [
  { label: 'OpenCode', value: 'opencode' },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
]

const updateConfigMutation = LaborerClient.mutation('config.update')
const provenanceClassName = 'text-[11px] leading-tight text-muted-foreground/70'

interface ProjectSettingsModalProps {
  readonly projectId: string
  readonly projectName: string
}

const toSetupScriptItems = (scripts: readonly string[]): SetupScriptItem[] =>
  scripts.map((script) => ({
    id: globalThis.crypto.randomUUID(),
    value: script,
  }))

function ProjectSettingsForm({
  projectId,
  projectName,
  onSaved,
}: {
  readonly projectId: string
  readonly projectName: string
  readonly onSaved: () => void
}) {
  const configGet$ = useMemo(
    () =>
      LaborerClient.query(
        'config.get',
        { projectId },
        { reactivityKeys: ConfigReactivityKeys }
      ),
    [projectId]
  )
  const configResult = useAtomValue(configGet$)
  const updateConfig = useAtomSet(updateConfigMutation, { mode: 'promise' })

  const [agent, setAgent] = useState<AgentProvider>('opencode')
  const [worktreeDir, setWorktreeDir] = useState('')
  const [setupScripts, setSetupScripts] = useState<SetupScriptItem[]>([])
  const [brrrConfig, setBrrrConfig] = useState('')
  const [devServerImage, setDevServerImage] = useState('')
  const [devServerInstallCommand, setDevServerInstallCommand] = useState('')
  const [devServerNetwork, setDevServerNetwork] = useState('')
  const [devServerAutoOpen, setDevServerAutoOpen] = useState(false)
  const [devServerSetupScripts, setDevServerSetupScripts] = useState<
    SetupScriptItem[]
  >([])
  const [devServerStartCommand, setDevServerStartCommand] = useState('')
  const [initialized, setInitialized] = useState(false)
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [isSaving, setIsSaving] = useState(false)
  const lastLoadErrorMessageRef = useRef<string | null>(null)

  const loadErrorMessage =
    configResult._tag === 'Failure'
      ? getSettingsLoadErrorMessage(extractErrorMessage(configResult.cause))
      : null

  useEffect(() => {
    if (configResult._tag !== 'Success' || initialized) {
      return
    }

    setAgent(configResult.value.agent.value)
    setWorktreeDir(configResult.value.worktreeDir.value)
    setSetupScripts(toSetupScriptItems(configResult.value.setupScripts.value))
    setBrrrConfig(configResult.value.brrrConfig.value ?? '')
    setDevServerAutoOpen(configResult.value.devServer.autoOpen.value)
    setDevServerImage(configResult.value.devServer.image.value ?? '')
    setDevServerInstallCommand(
      configResult.value.devServer.installCommand.value ?? ''
    )
    setDevServerNetwork(configResult.value.devServer.network.value ?? '')
    setDevServerSetupScripts(
      toSetupScriptItems(configResult.value.devServer.setupScripts.value)
    )
    setDevServerStartCommand(
      configResult.value.devServer.startCommand.value ?? ''
    )
    setInitialized(true)
  }, [configResult, initialized])

  useEffect(() => {
    if (!loadErrorMessage) {
      lastLoadErrorMessageRef.current = null
      return
    }

    if (lastLoadErrorMessageRef.current === loadErrorMessage) {
      return
    }

    lastLoadErrorMessageRef.current = loadErrorMessage
    toast.error(loadErrorMessage)
  }, [loadErrorMessage])

  if (
    configResult._tag !== 'Success' &&
    (configResult._tag === 'Initial' || configResult.waiting)
  ) {
    return (
      <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
        <Spinner className="size-4" />
        Loading project settings...
      </div>
    )
  }

  if (configResult._tag === 'Failure') {
    return (
      <div className="py-4 text-destructive text-sm">{loadErrorMessage}</div>
    )
  }

  if (configResult._tag !== 'Success') {
    return null
  }

  const resolvedConfig = configResult.value

  const handleSave = async () => {
    const updates = buildConfigUpdates({
      agent,
      devServerAutoOpen,
      devServerImage,
      devServerInstallCommand,
      devServerNetwork,
      devServerSetupScripts,
      devServerStartCommand,
      brrrConfig,
      resolvedConfig: {
        agent: resolvedConfig.agent.value,
        devServerAutoOpen: resolvedConfig.devServer.autoOpen.value,
        devServerImage: resolvedConfig.devServer.image.value,
        devServerInstallCommand: resolvedConfig.devServer.installCommand.value,
        devServerNetwork: resolvedConfig.devServer.network.value,
        devServerSetupScripts: resolvedConfig.devServer.setupScripts.value,
        devServerStartCommand: resolvedConfig.devServer.startCommand.value,
        brrrConfig: resolvedConfig.brrrConfig.value,
        setupScripts: resolvedConfig.setupScripts.value,
        worktreeDir: resolvedConfig.worktreeDir.value,
      },
      setupScripts,
      worktreeDir,
    })

    if (Object.keys(updates).length === 0) {
      toast.message('No config changes to save')
      return
    }

    setIsSaving(true)
    try {
      await updateConfig({
        payload: {
          projectId,
          config: updates,
        },
        reactivityKeys: ConfigReactivityKeys,
      })
      toast.success(`Saved settings for ${projectName}`)
      onSaved()
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error))
      setIsSaving(false)
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await handleSave()
  }

  return (
    <form className="contents" onSubmit={handleSubmit}>
      <div className="grid gap-4 py-2">
        <FieldSet>
          <Field>
            <FieldLabel>Agent</FieldLabel>
            <Select
              onValueChange={(value) => setAgent(value as AgentProvider)}
              value={agent}
            >
              <SelectTrigger>
                <SelectValue>
                  {(() => {
                    const option = AGENT_OPTIONS.find((o) => o.value === agent)
                    const Icon = AGENT_ICONS[agent]
                    return (
                      <>
                        <Icon className="size-3.5" />
                        {option?.label ?? agent}
                      </>
                    )
                  })()}
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
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.agent.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`worktree-dir-${projectId}`}>
              Worktree directory
            </FieldLabel>
            <Input
              id={`worktree-dir-${projectId}`}
              onChange={(event) => setWorktreeDir(event.target.value)}
              placeholder={`~/.config/laborer/${projectName}`}
              value={worktreeDir}
            />
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.worktreeDir.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Setup scripts</FieldLabel>
            <div className="grid gap-2">
              {setupScripts.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No setup scripts configured.
                </p>
              )}
              {setupScripts.map((script) => (
                <div className="flex items-center gap-2" key={script.id}>
                  <Input
                    aria-label="Setup script"
                    className="truncate"
                    id={`setup-script-${projectId}-${script.id}`}
                    onChange={(event) => {
                      setSetupScripts((prev) => {
                        return prev.map((item) => {
                          if (item.id !== script.id) {
                            return item
                          }

                          return {
                            ...item,
                            value: event.target.value,
                          }
                        })
                      })
                    }}
                    placeholder="bun install"
                    value={script.value}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Remove setup script"
                          onClick={() => {
                            setSetupScripts((prev) =>
                              prev.filter((item) => item.id !== script.id)
                            )
                          }}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        />
                      }
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Remove script</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <FieldDescription className={provenanceClassName}>
                Source: {resolvedConfig.setupScripts.source}
              </FieldDescription>
              <Button
                aria-label="Add setup script"
                onClick={() => {
                  setSetupScripts((prev) => [
                    ...prev,
                    { id: globalThis.crypto.randomUUID(), value: '' },
                  ])
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <Plus className="size-3.5" />
                Add script
              </Button>
            </div>
          </Field>

          <Field>
            <div className="flex items-start justify-between gap-3">
              <div className="grid gap-1">
                <FieldLabel htmlFor={`dev-server-auto-open-${projectId}`}>
                  Auto-open dev server
                </FieldLabel>
                <FieldDescription>
                  Open the dev server on the right when spawning a workspace
                  terminal.
                </FieldDescription>
                <FieldDescription className={provenanceClassName}>
                  Source: {resolvedConfig.devServer.autoOpen.source}
                </FieldDescription>
              </div>
              <Checkbox
                checked={devServerAutoOpen}
                id={`dev-server-auto-open-${projectId}`}
                onCheckedChange={(checked) =>
                  setDevServerAutoOpen(checked === true)
                }
              />
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor={`dev-server-image-${projectId}`}>
              Container image
            </FieldLabel>
            <Input
              id={`dev-server-image-${projectId}`}
              onChange={(event) => setDevServerImage(event.target.value)}
              placeholder="oven/bun:latest"
              value={devServerImage}
            />
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.devServer.image.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`dev-server-install-command-${projectId}`}>
              Install command
            </FieldLabel>
            <Input
              id={`dev-server-install-command-${projectId}`}
              onChange={(event) =>
                setDevServerInstallCommand(event.target.value)
              }
              placeholder="Auto-detected from lockfile (e.g. pnpm install --frozen-lockfile)"
              value={devServerInstallCommand}
            />
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.devServer.installCommand.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`dev-server-network-${projectId}`}>
              Docker network
            </FieldLabel>
            <Input
              id={`dev-server-network-${projectId}`}
              onChange={(event) => setDevServerNetwork(event.target.value)}
              placeholder="e.g. myproject_default (leave empty for host network)"
              value={devServerNetwork}
            />
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.devServer.network.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Container setup scripts</FieldLabel>
            <div className="grid gap-2">
              {devServerSetupScripts.length === 0 && (
                <p className="text-muted-foreground text-xs">
                  No container setup scripts configured.
                </p>
              )}
              {devServerSetupScripts.map((script) => (
                <div className="flex items-center gap-2" key={script.id}>
                  <Input
                    aria-label="Container setup script"
                    className="truncate"
                    id={`dev-server-setup-script-${projectId}-${script.id}`}
                    onChange={(event) => {
                      setDevServerSetupScripts((prev) => {
                        return prev.map((item) => {
                          if (item.id !== script.id) {
                            return item
                          }

                          return {
                            ...item,
                            value: event.target.value,
                          }
                        })
                      })
                    }}
                    placeholder="apt-get install -y python3"
                    value={script.value}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label="Remove container setup script"
                          onClick={() => {
                            setDevServerSetupScripts((prev) =>
                              prev.filter((item) => item.id !== script.id)
                            )
                          }}
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                        />
                      }
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent>Remove script</TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2">
              <FieldDescription className={provenanceClassName}>
                Source: {resolvedConfig.devServer.setupScripts.source}
              </FieldDescription>
              <Button
                aria-label="Add container setup script"
                onClick={() => {
                  setDevServerSetupScripts((prev) => [
                    ...prev,
                    { id: globalThis.crypto.randomUUID(), value: '' },
                  ])
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <Plus className="size-3.5" />
                Add script
              </Button>
            </div>
          </Field>

          <Field>
            <FieldLabel htmlFor={`dev-server-start-command-${projectId}`}>
              Dev command
            </FieldLabel>
            <Input
              id={`dev-server-start-command-${projectId}`}
              onChange={(event) => setDevServerStartCommand(event.target.value)}
              placeholder="bun dev"
              value={devServerStartCommand}
            />
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.devServer.startCommand.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`brrr-config-${projectId}`}>
              brrr config
            </FieldLabel>
            <Input
              id={`brrr-config-${projectId}`}
              onChange={(event) => setBrrrConfig(event.target.value)}
              placeholder=".brrr/config.toml"
              value={brrrConfig}
            />
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.brrrConfig.source}
            </FieldDescription>
          </Field>
        </FieldSet>
      </div>
      <DialogFooter>
        <Button disabled={!isServerReady || isSaving} type="submit">
          {isSaving && <Spinner className="size-3.5" />}
          {isSaving ? 'Saving...' : 'Save'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ProjectSettingsModal({
  projectId,
  projectName,
}: ProjectSettingsModalProps) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button
                  aria-label={`Open settings for ${projectName}`}
                  className="h-7 w-7"
                  size="icon-sm"
                  variant="ghost"
                />
              }
            />
          }
        >
          <Settings className="size-3.5 text-muted-foreground" />
        </TooltipTrigger>
        <TooltipContent>Project settings</TooltipContent>
      </Tooltip>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Configure dev server, worktree path, setup scripts, and brrr config
            for {projectName}.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ProjectSettingsForm
            onSaved={() => setOpen(false)}
            projectId={projectId}
            projectName={projectName}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export { ProjectSettingsModal }
