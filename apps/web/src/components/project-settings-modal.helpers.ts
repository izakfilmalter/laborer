interface SetupScriptItem {
  readonly id: string
  readonly value: string
}

interface ResolvedConfigSnapshot {
  readonly devServerImage: string | null
  readonly devServerStartCommand: string | null
  readonly rlphConfig: string | null
  readonly setupScripts: readonly string[]
  readonly worktreeDir: string
}

interface ConfigUpdates {
  devServer?: {
    image?: string
    startCommand?: string
  }
  rlphConfig?: string
  setupScripts?: string[]
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
  devServerImage,
  devServerStartCommand,
  rlphConfig,
  resolvedConfig,
  setupScripts,
  worktreeDir,
}: {
  devServerImage: string
  devServerStartCommand: string
  rlphConfig: string
  resolvedConfig: ResolvedConfigSnapshot
  setupScripts: readonly SetupScriptItem[]
  worktreeDir: string
}): ConfigUpdates => {
  const updates: ConfigUpdates = {}

  const normalizedWorktreeDir = worktreeDir.trim()
  const normalizedSetupScripts = normalizeSetupScripts(setupScripts)
  const normalizedRlphConfig = rlphConfig.trim()
  const normalizedDevServerImage = devServerImage.trim()
  const normalizedDevServerStartCommand = devServerStartCommand.trim()

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

  if (
    normalizedRlphConfig.length > 0 &&
    normalizedRlphConfig !== (resolvedConfig.rlphConfig ?? '')
  ) {
    updates.rlphConfig = normalizedRlphConfig
  }

  const imageChanged =
    normalizedDevServerImage !== (resolvedConfig.devServerImage ?? '')
  const startCommandChanged =
    normalizedDevServerStartCommand !==
    (resolvedConfig.devServerStartCommand ?? '')

  if (imageChanged || startCommandChanged) {
    const devServer: ConfigUpdates['devServer'] = {}
    if (imageChanged) {
      devServer.image = normalizedDevServerImage
    }
    if (startCommandChanged) {
      devServer.startCommand = normalizedDevServerStartCommand
    }
    updates.devServer = devServer
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

  return 'Failed to load project settings.'
}

export {
  areStringArraysEqual,
  buildConfigUpdates,
  getSettingsLoadErrorMessage,
  normalizeSetupScripts,
}
export type { ResolvedConfigSnapshot, SetupScriptItem }
