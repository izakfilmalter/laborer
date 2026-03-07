import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { Plus, Settings, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
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
import { Spinner } from '@/components/ui/spinner'
import { extractErrorMessage } from '@/lib/utils'
import {
  buildConfigUpdates,
  getSettingsLoadErrorMessage,
  type SetupScriptItem,
} from './project-settings-modal.helpers'

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
    () => LaborerClient.query('config.get', { projectId }),
    [projectId]
  )
  const configResult = useAtomValue(configGet$)
  const updateConfig = useAtomSet(updateConfigMutation, { mode: 'promise' })

  const [worktreeDir, setWorktreeDir] = useState('')
  const [setupScripts, setSetupScripts] = useState<SetupScriptItem[]>([])
  const [rlphConfig, setRlphConfig] = useState('')
  const [devServerImage, setDevServerImage] = useState('')
  const [devServerSetupScripts, setDevServerSetupScripts] = useState<
    SetupScriptItem[]
  >([])
  const [devServerStartCommand, setDevServerStartCommand] = useState('')
  const [initialized, setInitialized] = useState(false)
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

    setWorktreeDir(configResult.value.worktreeDir.value)
    setSetupScripts(toSetupScriptItems(configResult.value.setupScripts.value))
    setRlphConfig(configResult.value.rlphConfig.value ?? '')
    setDevServerImage(configResult.value.devServer.image.value ?? '')
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
      devServerImage,
      devServerSetupScripts,
      devServerStartCommand,
      rlphConfig,
      resolvedConfig: {
        devServerImage: resolvedConfig.devServer.image.value,
        devServerSetupScripts: resolvedConfig.devServer.setupScripts.value,
        devServerStartCommand: resolvedConfig.devServer.startCommand.value,
        rlphConfig: resolvedConfig.rlphConfig.value,
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
                  >
                    <Trash2 className="size-3.5 text-muted-foreground" />
                  </Button>
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
                  >
                    <Trash2 className="size-3.5 text-muted-foreground" />
                  </Button>
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
            <FieldLabel htmlFor={`rlph-config-${projectId}`}>
              rlph config
            </FieldLabel>
            <Input
              id={`rlph-config-${projectId}`}
              onChange={(event) => setRlphConfig(event.target.value)}
              placeholder=".rlph/config.json"
              value={rlphConfig}
            />
            <FieldDescription className={provenanceClassName}>
              Source: {resolvedConfig.rlphConfig.source}
            </FieldDescription>
          </Field>
        </FieldSet>
      </div>
      <DialogFooter>
        <Button disabled={isSaving} type="submit">
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
      <DialogTrigger
        render={
          <Button
            aria-label={`Open settings for ${projectName}`}
            className="h-7 w-7"
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        <Settings className="size-3.5 text-muted-foreground" />
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Configure dev server, worktree path, setup scripts, and rlph config
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
