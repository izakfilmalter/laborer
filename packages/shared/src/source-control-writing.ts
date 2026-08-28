/**
 * How the model should write commit messages and pull request descriptions.
 *
 * These preferences steer generation only — they never change which git steps
 * run — so they live as one app-wide setting rather than per project. The
 * whole object is stored as JSON under a single `app_settings` key, which
 * keeps adding a knob to a schema change here instead of a migration.
 *
 * @see packages/server/src/services/source-control-text-generation.ts
 * @see apps/web/src/components/app-settings-modal.tsx
 */

import { Schema } from 'effect'

/** The `app_settings` key holding the JSON below. */
export const SOURCE_CONTROL_WRITING_SETTING_KEY = 'source_control_writing'

/** Longest custom instruction the setting accepts, to bound the prompt. */
export const SOURCE_CONTROL_CUSTOM_INSTRUCTIONS_MAX_LENGTH = 2000

/**
 * Which voice generated text should speak in.
 *
 * `repo_conventions` reads the repository's recent commit subjects and asks
 * the model to sound like them, which is the right default because a branch's
 * history is the most honest style guide it has.
 */
export const SourceControlWritingMode = Schema.Literals([
  'repo_conventions',
  'conventional_commits',
  'custom',
])
export type SourceControlWritingMode = typeof SourceControlWritingMode.Type

export const SourceControlWritingSettings = Schema.Struct({
  /** Free-text steering, used only in `custom` mode. */
  customInstructions: Schema.String,
  /**
   * Whether a repository's pull request template should shape the generated
   * body. Off means the model writes its own Summary/Testing sections.
   */
  followPrTemplate: Schema.Boolean,
  /** The OpenCode model that writes, as `provider/model`. */
  model: Schema.String,
  mode: SourceControlWritingMode,
})
export type SourceControlWritingSettings =
  typeof SourceControlWritingSettings.Type

/**
 * The model that writes when nobody has chosen one.
 *
 * Same model the Slack planner uses: this is short, structured, latency-
 * sensitive summarization, not reasoning about a codebase.
 */
export const DEFAULT_SOURCE_CONTROL_MODEL = 'openai/gpt-5.6-sol-fast'

export const DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS: SourceControlWritingSettings =
  {
    customInstructions: '',
    followPrTemplate: true,
    model: DEFAULT_SOURCE_CONTROL_MODEL,
    mode: 'repo_conventions',
  }

const isMode = (value: unknown): value is SourceControlWritingMode =>
  value === 'repo_conventions' ||
  value === 'conventional_commits' ||
  value === 'custom'

/**
 * Read the stored setting, falling back field by field.
 *
 * A malformed or partial value must never stop a commit from being written,
 * so every field degrades to its default independently rather than the whole
 * setting being rejected.
 */
export const decodeSourceControlWritingSettings = (
  storedValue: string | null | undefined
): SourceControlWritingSettings => {
  if (storedValue === null || storedValue === undefined || storedValue === '') {
    return DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(storedValue)
  } catch {
    return DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS
  }

  const raw = parsed as Record<string, unknown>
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''

  return {
    customInstructions:
      typeof raw.customInstructions === 'string'
        ? raw.customInstructions.slice(
            0,
            SOURCE_CONTROL_CUSTOM_INSTRUCTIONS_MAX_LENGTH
          )
        : DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS.customInstructions,
    followPrTemplate:
      typeof raw.followPrTemplate === 'boolean'
        ? raw.followPrTemplate
        : DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS.followPrTemplate,
    model: model === '' ? DEFAULT_SOURCE_CONTROL_MODEL : model,
    mode: isMode(raw.mode)
      ? raw.mode
      : DEFAULT_SOURCE_CONTROL_WRITING_SETTINGS.mode,
  }
}

export const encodeSourceControlWritingSettings = (
  settings: SourceControlWritingSettings
): string => JSON.stringify(settings)
