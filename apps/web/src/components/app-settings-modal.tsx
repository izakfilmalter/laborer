import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { AGENT_ICONS } from '@/components/agent-icons'
import { useAppSettings } from '@/components/app-settings-context'
import { extractErrorMessage } from '@/lib/utils'
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

const updateGlobalConfigMutation = LaborerClient.mutation('globalConfig.update')

export function AppSettingsModal() {
  const { open, onOpenChange } = useAppSettings()

  const globalConfigGet$ = useMemo(
    // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
    () => LaborerClient.query('globalConfig.get', undefined as void),
    []
  )
  const globalConfigResult = useAtomValue(globalConfigGet$)
  const updateGlobalConfig = useAtomSet(updateGlobalConfigMutation, {
    mode: 'promise',
  })

  const [agent, setAgent] = useState<AgentProvider>('opencode')
  const [initialized, setInitialized] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    if (globalConfigResult._tag !== 'Success' || initialized) {
      return
    }

    setAgent(globalConfigResult.value.agent ?? 'opencode')
    setInitialized(true)
  }, [globalConfigResult, initialized])

  const handleSave = useCallback(async () => {
    setIsSaving(true)
    try {
      await updateGlobalConfig({
        payload: {
          config: { agent },
        },
      })
      toast.success('Saved global settings')
      onOpenChange(false)
    } catch (error: unknown) {
      toast.error(extractErrorMessage(error))
    } finally {
      setIsSaving(false)
    }
  }, [agent, updateGlobalConfig, onOpenChange])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        setInitialized(false)
      }
      onOpenChange(nextOpen)
    },
    [onOpenChange]
  )

  const AgentIcon =
    agent in AGENT_ICONS ? AGENT_ICONS[agent] : AGENT_ICONS.opencode

  const isLoading =
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
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
              <Spinner className="size-4" />
              Loading settings...
            </div>
          ) : (
            <FieldSet>
              <Field>
                <FieldLabel>Default agent</FieldLabel>
                <Select
                  onValueChange={(value) => setAgent(value as AgentProvider)}
                  value={agent}
                >
                  <SelectTrigger>
                    <SelectValue>
                      <AgentIcon className="size-3.5" />
                      {AGENT_OPTIONS.find((o) => o.value === agent)?.label ??
                        agent}
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
                <FieldDescription>
                  The CLI agent to use when opening new agent panels. Projects
                  can override this in their own laborer.json.
                </FieldDescription>
              </Field>
            </FieldSet>
          )}
        </div>

        <DialogFooter>
          <Button disabled={isSaving || isLoading} onClick={handleSave}>
            {isSaving && <Spinner className="size-3.5" />}
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
