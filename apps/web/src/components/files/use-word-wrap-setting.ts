import { useAtomSet } from '@effect/atom-react/Hooks'
import { useLiveQuery } from '@tanstack/react-db'
import { useCallback } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { setSetting } from '@/db/shared-mutations'
import { settingCollection } from '@/db/shared-state'

export const WORD_WRAP_SETTING_KEY = 'files.wordWrap'

const setAppSettingMutation = LaborerClient.mutation('appSetting.set')

export function useWordWrapSetting(): readonly [
  boolean,
  (value: boolean) => void,
] {
  const { data: settings } = useLiveQuery((query) =>
    query.from({ settings: settingCollection })
  )
  const send = useAtomSet(setAppSettingMutation, { mode: 'promise' })
  const value =
    settings.find((setting) => setting.key === WORD_WRAP_SETTING_KEY)?.value !==
    'false'
  const setValue = useCallback(
    (next: boolean) => {
      setSetting({
        key: WORD_WRAP_SETTING_KEY,
        operationId: crypto.randomUUID(),
        send: (payload) => send({ payload }),
        value: String(next),
      }).catch(() => undefined)
    },
    [send]
  )
  return [value, setValue]
}
