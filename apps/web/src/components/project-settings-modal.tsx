import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import type { AgentProvider } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@laborer/ui/components/dialog'
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldSet,
} from '@laborer/ui/components/field'
import { Input } from '@laborer/ui/components/input'
import { Kbd } from '@laborer/ui/components/kbd'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@laborer/ui/components/select'
import { Spinner } from '@laborer/ui/components/spinner'
import { Textarea } from '@laborer/ui/components/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@laborer/ui/components/tooltip'
import { Plus, Settings, Trash2 } from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'
import { AGENT_ICONS } from '@/components/agent-icons'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
import { ProjectAppearanceField } from '@/components/project-appearance-field'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { isMetaEnter } from '@/lib/dialog-keys'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import {
  buildConfigUpdates,
  getSettingsLoadErrorMessage,
  type SetupScriptItem,
} from './project-settings-modal.helpers'

const AGENT_OPTIONS: ReadonlyArray<{
  readonly label: string
  readonly value: AgentProvider
}> = [
  { label: 'OpenCode 2', value: 'opencode2' },
  { label: 'Claude', value: 'claude' },
  { label: 'Codex', value: 'codex' },
]

const updateConfigMutation = LaborerClient.mutation('config.update')
const provenanceClassName = 'text-[11px] leading-tight text-muted-foreground/70'

const createConfigGetQuery = (projectId: string) =>
  LaborerClient.query(
    'config.get',
    { projectId },
    {
      reactivityKeys: ConfigReactivityKeys,
    }
  )

type ConfigGetQuery = ReturnType<typeof createConfigGetQuery>

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
  configGet$,
  projectId,
  projectName,
  onSaved,
}: {
  readonly configGet$: ConfigGetQuery
  readonly projectId: string
  readonly projectName: string
  readonly onSaved: () => void
}) {
  const configResult = useAtomValue(configGet$)

  const updateConfig = useAtomSet(updateConfigMutation, { mode: 'promise' })

  const [agent, setAgent] = useState<AgentProvider>('opencode2')
  const [conflictPrompt, setConflictPrompt] = useState('')
  const [shortName, setShortName] = useState('')
  const [worktreeDir, setWorktreeDir] = useState('')
  const [setupScripts, setSetupScripts] = useState<SetupScriptItem[]>([])
  const [initialized, setInitialized] = useState(false)
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [isSaving, setIsSaving] = useState(false)
  const lastLoadErrorMessageRef = useRef<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const loadErrorMessage =
    configResult._tag === 'Failure'
      ? getSettingsLoadErrorMessage(extractErrorMessage(configResult.cause))
      : null

  useEffect(() => {
    if (configResult._tag !== 'Success' || initialized) {
      return
    }

    setAgent(configResult.value.agent.value)
    setConflictPrompt(configResult.value.conflictPrompt.value)
    setShortName(configResult.value.shortName.value)
    setWorktreeDir(configResult.value.worktreeDir.value)
    setSetupScripts(toSetupScriptItems(configResult.value.setupScripts.value))
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
      conflictPrompt,
      resolvedConfig: {
        agent: resolvedConfig.agent.value,
        conflictPrompt: resolvedConfig.conflictPrompt.value,
        shortName: resolvedConfig.shortName.value,
        setupScripts: resolvedConfig.setupScripts.value,
        worktreeDir: resolvedConfig.worktreeDir.value,
      },
      setupScripts,
      shortName,
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
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Form needs Cmd+Enter keyboard shortcut to submit
    <form
      className="contents"
      onKeyDown={(event: KeyboardEvent<HTMLFormElement>) => {
        if (isMetaEnter(event.nativeEvent) && !isSaving && isServerReady) {
          event.preventDefault()
          formRef.current?.requestSubmit()
        }
      }}
      onSubmit={handleSubmit}
      ref={formRef}
    >
      <div className="grid gap-4 py-2">
        <FieldSet>
          <ProjectAppearanceField
            projectId={projectId}
            projectName={projectName}
          />

          <Field>
            <FieldLabel htmlFor={`short-name-${projectId}`}>
              Project short name
            </FieldLabel>
            <Input
              data-testid="project-short-name"
              id={`short-name-${projectId}`}
              maxLength={10}
              onChange={(event) =>
                setShortName(
                  event.target.value.toUpperCase().replaceAll(/[^A-Z0-9]/g, '')
                )
              }
              pattern="[A-Z][A-Z0-9]{0,9}"
              placeholder="LAB"
              required
              value={shortName}
            />
            <FieldDescription className={provenanceClassName}>
              Used for task IDs, for example {shortName || 'LAB'}-123. Source:{' '}
              {resolvedConfig.shortName.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel>Agent</FieldLabel>
            <Select
              onValueChange={(value) => setAgent(value as AgentProvider)}
              value={agent}
            >
              <SelectTrigger data-testid="project-agent-select">
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
                    <SelectItem
                      data-testid={`project-agent-option-${option.value}`}
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
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.agent.source}
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`worktree-dir-${projectId}`}>
              Worktree directory
            </FieldLabel>
            <Input
              data-testid="project-worktree-dir"
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
            <FieldLabel htmlFor={`conflict-prompt-${projectId}`}>
              Conflict prompt
            </FieldLabel>
            <Textarea
              className="min-h-24 font-mono text-xs"
              data-testid="project-conflict-prompt"
              id={`conflict-prompt-${projectId}`}
              onChange={(event) => setConflictPrompt(event.target.value)}
              placeholder="Rebase this branch onto its base branch and resolve every merge conflict."
              value={conflictPrompt}
            />
            <FieldDescription className={provenanceClassName}>
              Run in a new agent when you click a workspace's merge conflict
              mark. Leave empty to keep the mark read-only. Source:{' '}
              {resolvedConfig.conflictPrompt.source}
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
                    data-testid="project-setup-script"
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
                data-testid="add-project-setup-script"
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
        </FieldSet>
      </div>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>
          Cancel <Kbd>Esc</Kbd>
        </DialogClose>
        <Button
          data-testid="save-project-settings"
          disabled={!isServerReady || isSaving}
          type="submit"
        >
          {isSaving && <Spinner className="size-3.5" />}
          {isSaving ? 'Saving...' : 'Save'}
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd>
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
  const configGet$ = useMemo(() => createConfigGetQuery(projectId), [projectId])
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)

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
                  data-testid="open-project-settings"
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
      <DialogContent className="sm:max-w-2xl" data-testid="project-settings">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Configure the task short name, agent, worktree path, conflict
            prompt, and setup scripts for {projectName}.
          </DialogDescription>
        </DialogHeader>
        {open && !isServerReady && (
          <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Connecting to server...
          </div>
        )}
        {open && isServerReady && (
          <ProjectSettingsForm
            configGet$={configGet$}
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
