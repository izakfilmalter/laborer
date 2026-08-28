/**
 * How the model should write commit messages and pull request descriptions.
 *
 * The one-click "Commit, push & PR" button never asks for words, which makes
 * the voice it writes in a preference rather than a per-commit decision — so
 * it lives here, app-wide, next to the other things that are true of every
 * project.
 *
 * Nothing here changes which git steps run. Every control on this panel only
 * steers generation.
 *
 * @see packages/shared/src/source-control-writing.ts — the stored shape
 * @see apps/web/src/components/git-actions-control.tsx — the button it steers
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import {
  decodeSourceControlWritingSettings,
  encodeSourceControlWritingSettings,
  SOURCE_CONTROL_CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  SOURCE_CONTROL_WRITING_SETTING_KEY,
  type SourceControlWritingMode,
  type SourceControlWritingSettings as SourceControlWritingSettingsValue,
} from '@laborer/shared/source-control-writing'
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldSet,
} from '@laborer/ui/components/field'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@laborer/ui/components/select'
import { Switch } from '@laborer/ui/components/switch'
import { Textarea } from '@laborer/ui/components/textarea'
import { useLiveQuery } from '@tanstack/react-db'
import { useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { setSetting as setSettingOptimistically } from '@/db/shared-mutations'
import { settingCollection } from '@/db/shared-state'
import { extractErrorMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'

const MODE_OPTIONS: ReadonlyArray<{
  readonly description: string
  readonly label: string
  readonly value: SourceControlWritingMode
}> = [
  {
    description:
      "Sound like the branch's recent commits. The repository is its own style guide.",
    label: 'Repository conventions',
    value: 'repo_conventions',
  },
  {
    description: 'Write subjects as Conventional Commits (feat:, fix:, …).',
    label: 'Conventional Commits',
    value: 'conventional_commits',
  },
  {
    description: 'Follow the instructions you write below.',
    label: 'Custom instructions',
    value: 'custom',
  },
]

const setAppSettingMutation = LaborerClient.mutation('appSetting.set')
const openCodeModels$ = LaborerClient.query(
  'opencode.models',
  // biome-ignore lint/suspicious/noConfusingVoidType: Effect RPC uses void for empty payloads
  undefined as void
)

/**
 * The models to offer, grouped by provider.
 *
 * The stored model is always included even when OpenCode no longer lists it —
 * a provider logged out of should not silently rewrite the setting to
 * something the operator never chose.
 */
function groupModelsByProvider(
  models: readonly string[],
  selected: string
): ReadonlyArray<readonly [string, readonly string[]]> {
  const byProvider = new Map<string, string[]>()
  for (const id of [...models, selected].sort()) {
    const provider = id.slice(0, id.indexOf('/'))
    if (provider === '') {
      continue
    }
    const group = byProvider.get(provider) ?? []
    if (!group.includes(id)) {
      group.push(id)
    }
    byProvider.set(provider, group)
  }
  return [...byProvider.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )
}

/** The part of the id that is not the provider, which the group already names. */
const modelLabel = (id: string): string => id.slice(id.indexOf('/') + 1)

export function SourceControlWritingSettings() {
  const { data: settings } = useLiveQuery((query) =>
    query.from({ settings: settingCollection })
  )
  const setAppSetting = useAtomSet(setAppSettingMutation, { mode: 'promise' })

  const stored = decodeSourceControlWritingSettings(
    settings.find((row) => row.key === SOURCE_CONTROL_WRITING_SETTING_KEY)
      ?.value
  )

  // Custom instructions are edited locally and committed on blur, so a
  // keystroke does not become a write. Everything else lands immediately.
  const [draftInstructions, setDraftInstructions] = useState<string | null>(
    null
  )

  // A machine with no OpenCode credentials, or one where listing them failed,
  // still gets a working panel showing the model it is set to.
  const modelsResult = useAtomValue(openCodeModels$)
  const availableModels =
    modelsResult._tag === 'Success' ? modelsResult.value.models : []
  const hasModelList = availableModels.length > 0
  const modelGroups = groupModelsByProvider(availableModels, stored.model)

  const save = (next: SourceControlWritingSettingsValue) => {
    setSettingOptimistically({
      key: SOURCE_CONTROL_WRITING_SETTING_KEY,
      operationId: crypto.randomUUID(),
      send: (payload) => setAppSetting({ payload }),
      value: encodeSourceControlWritingSettings(next),
    }).catch((error: unknown) => {
      toast.error(extractErrorMessage(error))
    })
  }

  const activeMode = MODE_OPTIONS.find((option) => option.value === stored.mode)

  return (
    <FieldSet>
      <div className="space-y-1">
        <h3 className="font-medium text-sm">Commit and PR writing</h3>
        <p className="text-muted-foreground text-sm">
          Commit messages and pull request descriptions are written from the
          diff. These settings decide how they read.
        </p>
      </div>

      <Field>
        <FieldLabel>Writing style</FieldLabel>
        <Select
          onValueChange={(value) =>
            save({ ...stored, mode: value as SourceControlWritingMode })
          }
          value={stored.mode}
        >
          <SelectTrigger data-testid="source-control-writing-mode">
            <SelectValue>{activeMode?.label ?? stored.mode}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MODE_OPTIONS.map((option) => (
              <SelectItem
                data-testid={`source-control-writing-mode-${option.value}`}
                key={option.value}
                value={option.value}
              >
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{activeMode?.description}</FieldDescription>
      </Field>

      {stored.mode === 'custom' && (
        <Field>
          <FieldLabel htmlFor="source-control-custom-instructions">
            Custom instructions
          </FieldLabel>
          <Textarea
            data-testid="source-control-custom-instructions"
            id="source-control-custom-instructions"
            maxLength={SOURCE_CONTROL_CUSTOM_INSTRUCTIONS_MAX_LENGTH}
            onBlur={() => {
              if (
                draftInstructions !== null &&
                draftInstructions !== stored.customInstructions
              ) {
                save({ ...stored, customInstructions: draftInstructions })
              }
              setDraftInstructions(null)
            }}
            onChange={(event) => setDraftInstructions(event.target.value)}
            placeholder="Keep subjects short. Use bullet points in descriptions."
            rows={3}
            value={draftInstructions ?? stored.customInstructions}
          />
          <FieldDescription>
            Applied to both commit messages and pull request descriptions.
          </FieldDescription>
        </Field>
      )}

      <Field orientation="horizontal">
        <div className="space-y-1">
          <FieldLabel htmlFor="source-control-follow-template">
            Follow the repository&apos;s PR template
          </FieldLabel>
          <FieldDescription>
            When a repository ships a pull request template, fill it in instead
            of writing Summary and Testing sections.
          </FieldDescription>
        </div>
        <Switch
          checked={stored.followPrTemplate}
          data-testid="source-control-follow-template"
          id="source-control-follow-template"
          onCheckedChange={(checked) =>
            save({ ...stored, followPrTemplate: checked })
          }
        />
      </Field>

      <Field>
        <FieldLabel>Writing model</FieldLabel>
        <Select
          onValueChange={(value) => save({ ...stored, model: value as string })}
          value={stored.model}
        >
          <SelectTrigger data-testid="source-control-model">
            <SelectValue>{stored.model}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {modelGroups.map(([provider, ids]) => (
              <SelectGroup key={provider}>
                <SelectLabel>{provider}</SelectLabel>
                {ids.map((id) => (
                  <SelectItem
                    data-testid={`source-control-model-option-${id}`}
                    key={id}
                    value={id}
                  >
                    {modelLabel(id)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>
          {hasModelList
            ? 'The models OpenCode is signed in to. Summarizing a diff is short work, so a fast model is usually the right one.'
            : 'OpenCode has not reported any models yet. Sign in with `opencode2 auth login` to choose a different one.'}
        </FieldDescription>
      </Field>
    </FieldSet>
  )
}
