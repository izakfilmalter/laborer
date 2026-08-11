import { Result } from '@effect-atom/atom'
import { useAtomSet, useAtomValue } from '@effect-atom/atom-react/Hooks'
import { useEffect, useMemo } from 'react'
import {
  installSharedStateUpdateAtom,
  makeSharedStateEventsAtom,
} from '@/atoms/shared-state'

/** Owns the one app-wide shared database subscription. */
export function SharedStateBridge(): null {
  const eventsAtom = useMemo(makeSharedStateEventsAtom, [])
  const result = useAtomValue(eventsAtom)
  const pullNext = useAtomSet(eventsAtom)
  const install = useAtomSet(installSharedStateUpdateAtom)

  useEffect(() => {
    if (Result.isSuccess(result) && !result.waiting) {
      for (const update of result.value.items) {
        install(update)
      }
      // biome-ignore lint/suspicious/noConfusingVoidType: pull atom write type is void
      pullNext(undefined as void)
    }
  }, [install, pullNext, result])

  return null
}
