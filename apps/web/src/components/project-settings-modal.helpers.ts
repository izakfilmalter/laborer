import type { AgentProvider } from '@laborer/shared/rpc'

interface SetupScriptItem {
  readonly id: string
  readonly value: string
}

interface ResolvedConfigSnapshot {
  readonly agent: AgentProvider
  readonly setupScripts: readonly string[]
  readonly shortName: string
  readonly worktreeDir: string
}

interface ConfigUpdates {
  agent?: AgentProvider
  setupScripts?: string[]
  shortName?: string
  worktreeDir?: string
}

const normalizeSetupScripts = (
  setupScripts: readonly SetupScriptItem[]
): string[] =>
  setupScripts
    .map((script) => script.value.trim())
    .filter((script) => script.length > 0)

const areStringArraysEqual = (
  a: readonly string[],
  b: readonly string[]
): boolean => {
  if (a.length !== b.length) {
    return false
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }

  return true
}

const buildConfigUpdates = ({
  agent,
  resolvedConfig,
  shortName,
  setupScripts,
  worktreeDir,
}: {
  agent: AgentProvider
  resolvedConfig: ResolvedConfigSnapshot
  shortName: string
  setupScripts: readonly SetupScriptItem[]
  worktreeDir: string
}): ConfigUpdates => {
  const updates: ConfigUpdates = {}

  const normalizedShortName = shortName.trim().toUpperCase()
  if (normalizedShortName !== resolvedConfig.shortName) {
    updates.shortName = normalizedShortName
  }

  if (agent !== resolvedConfig.agent) {
    updates.agent = agent
  }

  const normalizedWorktreeDir = worktreeDir.trim()
  const normalizedSetupScripts = normalizeSetupScripts(setupScripts)

  if (
    normalizedWorktreeDir.length > 0 &&
    normalizedWorktreeDir !== resolvedConfig.worktreeDir
  ) {
    updates.worktreeDir = normalizedWorktreeDir
  }

  if (
    !areStringArraysEqual(normalizedSetupScripts, resolvedConfig.setupScripts)
  ) {
    updates.setupScripts = normalizedSetupScripts
  }

  return updates
}

const getSettingsLoadErrorMessage = (message: string): string => {
  const lowercaseMessage = message.toLowerCase()
  if (
    lowercaseMessage.includes('parse') &&
    lowercaseMessage.includes('laborer.json')
  ) {
    return 'Could not read laborer.json. Fix the JSON syntax and reopen project settings.'
  }

  return `Failed to load project settings: ${message}`
}

export {
  areStringArraysEqual,
  buildConfigUpdates,
  getSettingsLoadErrorMessage,
  normalizeSetupScripts,
}
export type { ResolvedConfigSnapshot, SetupScriptItem }
