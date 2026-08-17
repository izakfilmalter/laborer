/**
 * The label picker, connected to shared state.
 *
 * Applying a label is the same act wherever a card is shown, so the option
 * list, the optimistic overlay, and the recovery from a rejected write live
 * here rather than in each surface. A surface renders
 * `<TaskLabelsControl task={task} />` and nothing else.
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import { createTaskUlid } from '@laborer/task-db/ulid'
import type { ReactElement, RefObject } from 'react'
import { toast } from 'sonner'

import { LaborerClient } from '@/atoms/laborer-client'
import {
  clearTaskLabelOverlayAtom,
  installTaskLabelOverlayAtom,
  labelRowsAtom,
  labelsByIdAtom,
} from '@/atoms/shared-state'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'

import { type TaskLabelOption, TaskLabelsPillTrigger } from './label-chips'
import { LabelsPicker } from './labels-picker'

const createLabelMutation = LaborerClient.mutation('label.create')
const setTaskLabelsMutation = LaborerClient.mutation('task.labels.set')

/** Resolves a task's stored ids into labels, dropping ids no label answers. */
export const resolveTaskLabels = (
  labelIds: readonly string[],
  byId: ReadonlyMap<string, TaskLabelOption>
): readonly TaskLabelOption[] =>
  labelIds
    .map((id) => byId.get(id))
    .filter((label): label is TaskLabelOption => label !== undefined)

/** A task's labels, resolved against shared state. */
export function useTaskLabels(
  labelIds: readonly string[]
): readonly TaskLabelOption[] {
  const byId = useAtomValue(labelsByIdAtom)
  return resolveTaskLabels(labelIds, byId)
}

export function TaskLabelsControl({
  task,
  disabled = false,
  openRef,
}: {
  readonly disabled?: boolean
  readonly openRef?: RefObject<(() => void) | null> | undefined
  readonly task: {
    readonly id: string
    readonly labelIds: readonly string[]
    readonly revision: number
  }
}): ReactElement {
  // Labels are app-wide, so every label is an option for every task.
  const options = useAtomValue(labelRowsAtom)
  const selected = useTaskLabels(task.labelIds)
  const createLabel = useAtomSet(createLabelMutation, { mode: 'promise' })
  const setTaskLabels = useAtomSet(setTaskLabelsMutation, { mode: 'promise' })
  const installOverlay = useAtomSet(installTaskLabelOverlayAtom)
  const clearOverlay = useAtomSet(clearTaskLabelOverlayAtom)

  const applyLabelIds = (labelIds: readonly string[]) => {
    installOverlay({
      overlay: { expectedRevision: task.revision, labelIds },
      taskId: task.id,
    })
    return setTaskLabels({
      payload: {
        expectedRevision: task.revision,
        labelIds,
        operationId: crypto.randomUUID(),
        taskId: task.id,
      },
    }).catch((error: unknown) => {
      clearOverlay(task.id)
      const conflict = extractErrorCode(error) === 'CAS_CONFLICT'
      toast.error(
        conflict ? 'Card changed elsewhere' : 'Could not update labels',
        {
          description: conflict
            ? 'This card changed elsewhere while saving. Its labels are shown as stored.'
            : extractErrorMessage(error),
        }
      )
    })
  }

  return (
    <LabelsPicker
      disabled={disabled}
      onCreateLabel={(name) => {
        // The id is minted here so the new label joins the selection in the
        // same gesture that created it, rather than after a round trip.
        const id = createTaskUlid()
        createLabel({
          payload: { id, name, operationId: crypto.randomUUID() },
        })
          .then(() => applyLabelIds([...task.labelIds, id]))
          .catch((error: unknown) => {
            toast.error('Could not create label', {
              description: extractErrorMessage(error),
            })
          })
      }}
      onValueChange={applyLabelIds}
      openRef={openRef}
      options={options}
      trigger={<TaskLabelsPillTrigger labels={selected} />}
      value={task.labelIds}
    />
  )
}
