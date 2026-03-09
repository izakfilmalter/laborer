interface SetupScriptItem {
  readonly id: string
  readonly value: string
}

interface ResolvedConfigSnapshot {
  readonly devServerImage: string | null
  readonly devServerInstallCommand: string | null
  readonly devServerNetwork: string | null
  readonly devServerSetupScripts: readonly string[]
  readonly devServerStartCommand: string | null
  readonly rlphConfig: string | null
  readonly setupScripts: readonly string[]
  readonly worktreeDir: string
}

interface ConfigUpdates {
  devServer?: {
    image?: string
    installCommand?: string
    network?: string
    setupScripts?: string[]
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

/**
 * Diff dev server fields and return a partial devServer update object,
 * or undefined if nothing changed.
 */
const buildDevServerUpdates = (
  current: {
    image: string
    installCommand: string
    network: string
    setupScripts: string[]
    startCommand: string
  },
  resolved: ResolvedConfigSnapshot
): ConfigUpdates['devServer'] | undefined => {
  const imageChanged = current.image !== (resolved.devServerImage ?? '')
  const installCommandChanged =
    current.installCommand !== (resolved.devServerInstallCommand ?? '')
  const networkChanged = current.network !== (resolved.devServerNetwork ?? '')
  const setupScriptsChanged = !areStringArraysEqual(
    current.setupScripts,
    resolved.devServerSetupScripts
  )
  const startCommandChanged =
    current.startCommand !== (resolved.devServerStartCommand ?? '')

  if (
    !(
      imageChanged ||
      installCommandChanged ||
      networkChanged ||
      setupScriptsChanged ||
      startCommandChanged
    )
  ) {
    return undefined
  }

  const devServer: ConfigUpdates['devServer'] = {}
  if (imageChanged) {
    devServer.image = current.image
  }
  if (installCommandChanged) {
    devServer.installCommand = current.installCommand
  }
  if (networkChanged) {
    devServer.network = current.network
  }
  if (setupScriptsChanged) {
    devServer.setupScripts = current.setupScripts
  }
  if (startCommandChanged) {
    devServer.startCommand = current.startCommand
  }
  return devServer
}

const buildConfigUpdates = ({
  devServerImage,
  devServerInstallCommand,
  devServerNetwork,
  devServerSetupScripts,
  devServerStartCommand,
  rlphConfig,
  resolvedConfig,
  setupScripts,
  worktreeDir,
}: {
  devServerImage: string
  devServerInstallCommand: string
  devServerNetwork: string
  devServerSetupScripts: readonly SetupScriptItem[]
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

  const devServerUpdate = buildDevServerUpdates(
    {
      image: devServerImage.trim(),
      installCommand: devServerInstallCommand.trim(),
      network: devServerNetwork.trim(),
      setupScripts: normalizeSetupScripts(devServerSetupScripts),
      startCommand: devServerStartCommand.trim(),
    },
    resolvedConfig
  )
  if (devServerUpdate !== undefined) {
    updates.devServer = devServerUpdate
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
