/** biome-ignore-all lint: editor launching is intentionally imperative OS integration code. */
import { spawn } from 'node:child_process'
import { access, constants as fsConstants } from 'node:fs/promises'
import path from 'node:path'

import type { ShellOpenInEditorInput } from '@laborer/contracts/shell'
import { ShellOpenInEditorError } from '@laborer/contracts/shell'
import { Context, Effect, Layer, Match } from 'effect'

interface EditorOpenerShape {
  readonly openInEditor: (
    input: ShellOpenInEditorInput
  ) => Effect.Effect<void, ShellOpenInEditorError>
}

export class EditorOpener extends Context.Tag('@laborer/server/EditorOpener')<
  EditorOpener,
  EditorOpenerShape
>() {
  static readonly layer = Layer.sync(this, createEditorOpener)
}

const OPEN_WITH_GOTO_COMMANDS = new Set([
  'code',
  'code-insiders',
  'cursor',
  'windsurf',
])

const DIRECT_TARGET_COMMANDS = new Set(['subl', 'zed'])

const EDITOR_CANDIDATES = [
  process.env.LABORER_EDITOR?.trim(),
  'cursor',
  'code',
  'code-insiders',
  'windsurf',
  'zed',
  'subl',
].filter(
  (candidate): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0
)

function createEditorOpener(): EditorOpenerShape {
  const openInEditor = Effect.fn('EditorOpener.openInEditor')(function* (
    input: ShellOpenInEditorInput
  ) {
    const target = splitTargetPath(input.path)

    yield* Effect.tryPromise({
      try: async () => {
        await access(target.filePath, fsConstants.F_OK)

        for (const command of EDITOR_CANDIDATES) {
          const didLaunch = await tryEditorCommand(command, target)
          if (didLaunch) {
            return
          }
        }

        await openWithSystemDefault(target)
      },
      catch: (cause) =>
        new ShellOpenInEditorError({
          path: input.path,
          message: buildOpenEditorMessage(input.path, cause),
          cause,
        }),
    })
  })

  return EditorOpener.of({ openInEditor })
}

const buildOpenEditorMessage = (targetPath: string, cause: unknown) => {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return `Unable to open ${targetPath}: ${cause.message}`
  }

  return `Unable to open ${targetPath} in an editor.`
}

const tryEditorCommand = async (
  command: string,
  target: ReturnType<typeof splitTargetPath>
): Promise<boolean> => {
  const args = buildEditorArgs(command, target)

  try {
    await spawnDetached(command, args)
    return true
  } catch (error) {
    if (isMissingCommandError(error)) {
      return false
    }

    throw error
  }
}

const buildEditorArgs = (
  command: string,
  target: ReturnType<typeof splitTargetPath>
): string[] => {
  const executable = path.basename(command).toLowerCase()

  if (OPEN_WITH_GOTO_COMMANDS.has(executable)) {
    return ['--goto', target.originalTarget]
  }

  if (DIRECT_TARGET_COMMANDS.has(executable)) {
    return [target.originalTarget]
  }

  return [target.filePath]
}

const openWithSystemDefault = async (
  target: ReturnType<typeof splitTargetPath>
): Promise<void> => {
  const filePath = target.filePath

  return Match.value(process.platform).pipe(
    Match.when('darwin', () => spawnDetached('open', [filePath])),
    Match.when('win32', () =>
      spawnDetached('cmd', ['/c', 'start', '', filePath])
    ),
    Match.orElse(() => spawnDetached('xdg-open', [filePath]))
  )
}

const spawnDetached = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    })

    const cleanup = () => {
      child.removeListener('error', onError)
      child.removeListener('spawn', onSpawn)
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onSpawn = () => {
      cleanup()
      child.unref()
      resolve()
    }

    child.once('error', onError)
    child.once('spawn', onSpawn)
  })

const isMissingCommandError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }

  const code = 'code' in error ? error.code : undefined
  return code === 'ENOENT'
}

const splitTargetPath = (value: string) => {
  let filePath = value
  let column: string | undefined
  let line: string | undefined

  const columnMatch = filePath.match(/:(\d+)$/)
  if (columnMatch?.[1]) {
    column = columnMatch[1]
    filePath = filePath.slice(0, -columnMatch[0].length)

    const lineMatch = filePath.match(/:(\d+)$/)
    if (lineMatch?.[1]) {
      line = lineMatch[1]
      filePath = filePath.slice(0, -lineMatch[0].length)
    } else {
      line = column
      column = undefined
    }
  }

  return {
    filePath,
    line,
    column,
    originalTarget: value,
  }
}
