import { useAtomValue } from '@effect/atom-react/Hooks'
import { useMemo } from 'react'
import { ConfigReactivityKeys, LaborerClient } from '@/atoms/laborer-client'

export const useProjectShortName = (projectId: string): string | null => {
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
  return result._tag === 'Success' ? result.value.shortName.value : null
}
