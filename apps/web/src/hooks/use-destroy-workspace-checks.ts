import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { useCallback, useRef, useState } from 'react'

import { LaborerClient } from '@/atoms/laborer-client'
import { type TerminalInfo, useTerminalList } from '@/hooks/use-terminal-list'

const checkDirtyMutation = LaborerClient.mutation('workspace.checkDirty')

interface ActiveTerminal {
  readonly id: string
  readonly label: string
}

interface DestroyWorkspaceChecks {
  readonly activeTerminals: readonly ActiveTerminal[]
  readonly dirtyFiles: readonly string[]
  readonly isCheckingDirtyFiles: boolean
  readonly isCheckingTerminals: boolean
  readonly reset: () => void
  readonly startChecks: () => void
}

const getActiveTerminalsForWorkspace = (
  workspaceId: string,
  terminals: readonly TerminalInfo[]
): readonly ActiveTerminal[] => {
  return terminals
    .filter((terminal) => {
      return (
        terminal.workspaceId === workspaceId &&
        terminal.hasChildProcess === true
      )
    })
    .map((terminal) => ({
      id: terminal.id,
      label: terminal.foregroundProcess?.label ?? 'Running process',
    }))
}

function useDestroyWorkspaceChecks(
  workspaceId: string
): DestroyWorkspaceChecks {
  const checkDirty = useAtomSet(checkDirtyMutation, {
    mode: 'promise',
  })
  const { refresh, terminals } = useTerminalList()
  const [dirtyFiles, setDirtyFiles] = useState<readonly string[]>([])
  const [activeTerminals, setActiveTerminals] = useState<
    readonly ActiveTerminal[]
  >([])
  const [isCheckingDirtyFiles, setIsCheckingDirtyFiles] = useState(false)
  const [isCheckingTerminals, setIsCheckingTerminals] = useState(false)
  const requestIdRef = useRef(0)

  const reset = useCallback(() => {
    requestIdRef.current += 1
    setDirtyFiles([])
    setActiveTerminals([])
    setIsCheckingDirtyFiles(false)
    setIsCheckingTerminals(false)
  }, [])

  const startChecks = useCallback(() => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId

    setDirtyFiles([])
    setActiveTerminals(getActiveTerminalsForWorkspace(workspaceId, terminals))
    setIsCheckingDirtyFiles(true)
    setIsCheckingTerminals(true)

    checkDirty({ payload: { workspaceId } })
      .then((files) => {
        if (requestIdRef.current !== requestId) {
          return
        }

        setDirtyFiles(files.length > 0 ? [...files] : [])
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) {
          return
        }

        setDirtyFiles([])
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) {
          return
        }

        setIsCheckingDirtyFiles(false)
      })

    refresh()
      .then((nextTerminals) => {
        if (requestIdRef.current !== requestId) {
          return
        }

        setActiveTerminals(
          getActiveTerminalsForWorkspace(workspaceId, nextTerminals)
        )
      })
      .catch(() => {
        if (requestIdRef.current !== requestId) {
          return
        }

        setActiveTerminals(
          getActiveTerminalsForWorkspace(workspaceId, terminals)
        )
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) {
          return
        }

        setIsCheckingTerminals(false)
      })
  }, [checkDirty, refresh, terminals, workspaceId])

  return {
    activeTerminals,
    dirtyFiles,
    isCheckingDirtyFiles,
    isCheckingTerminals,
    reset,
    startChecks,
  }
}

export { useDestroyWorkspaceChecks }
export type { ActiveTerminal }
