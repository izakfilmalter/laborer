/**
 * The prompt a project runs when an operator acts on a merge conflict.
 *
 * Returns `null` until the project's config resolves, and for projects that
 * have not written a prompt — the conflict mark stays a plain status mark
 * rather than a button that would do nothing.
 */

import { useAtomValue } from '@effect/atom-react/Hooks'
import { useMemo } from 'react'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'

export const useProjectConflictPrompt = (projectId: string): string | null => {
  const config$ = useMemo(
    () =>
      LaborerClient.query(
        'config.get',
        { projectId },
        { reactivityKeys: ConfigReactivityKeys }
      ),
    [projectId]
  )
  const result = useAtomValue(config$)

  if (result._tag !== 'Success') {
    return null
  }

  const prompt = result.value.conflictPrompt.value.trim()
  return prompt.length > 0 ? prompt : null
}
