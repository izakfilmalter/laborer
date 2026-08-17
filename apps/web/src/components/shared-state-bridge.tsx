import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import { useEffect, useMemo } from 'react'
import {
  installSharedStateUpdateAtom,
  makeSharedStateEventsAtom,
} from '@/atoms/shared-state'
import {
  preloadSharedStateCollections,
  sharedStateCoordinator,
} from '@/db/shared-state'

/** Owns the one app-wide shared database subscription. */
export function SharedStateBridge(): null {
  const eventsAtom = useMemo(makeSharedStateEventsAtom, [])
  const result = useAtomValue(eventsAtom)
  const pullNext = useAtomSet(eventsAtom)
  const installLegacyProjection = useAtomSet(installSharedStateUpdateAtom)

  useEffect(() => {
    if (Result.isSuccess(result) && !result.waiting) {
      let active = true
      preloadSharedStateCollections().then(() => {
        if (!active) {
          return
        }
        for (const update of result.value.items) {
          sharedStateCoordinator.apply(update)
          installLegacyProjection(update)
        }
        // biome-ignore lint/suspicious/noConfusingVoidType: pull atom write type is void
        pullNext(undefined as void)
      })
      return () => {
        active = false
      }
    }
    return undefined
  }, [installLegacyProjection, pullNext, result])

  return null
}
