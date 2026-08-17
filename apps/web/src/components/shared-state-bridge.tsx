import { RegistryContext } from '@effect/atom-react/RegistryContext'
import { AsyncResult as Result } from 'effect/unstable/reactivity'
import { useContext, useEffect, useMemo } from 'react'
import {
  installSharedStateUpdateAtom,
  makeSharedStateEventsAtom,
} from '@/atoms/shared-state'
import {
  type SharedStateSource,
  sharedCollectionBundle,
} from '@/db/shared-state'

/** Owns the one app-wide shared database subscription. */
export function SharedStateBridge(): null {
  const registry = useContext(RegistryContext)
  const eventsAtom = useMemo(makeSharedStateEventsAtom, [])
  const source = useMemo<SharedStateSource>(
    () => ({
      start: (publish) =>
        registry.subscribe(
          eventsAtom,
          (result) => {
            if (!(Result.isSuccess(result) && !result.waiting)) {
              return
            }
            for (const update of result.value.items) {
              publish(update)
              // Keep the cumulative branch's legacy consumers coherent until
              // their direct-query cutover lands in its own descendant issue.
              registry.set(installSharedStateUpdateAtom, update)
            }
            // biome-ignore lint/suspicious/noConfusingVoidType: pull atom write type is void
            registry.set(eventsAtom, undefined as void)
          },
          { immediate: true }
        ),
    }),
    [eventsAtom, registry]
  )

  useEffect(() => sharedCollectionBundle.activate(source), [source])

  return null
}
