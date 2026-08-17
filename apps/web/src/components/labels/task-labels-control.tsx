/**
 * The label picker, connected to shared state.
 *
 * Applying a label is the same act wherever a card is shown, so the option
 * list, the optimistic overlay, and the recovery from a rejected write live
 * here rather than in each surface. A surface renders
 * `<TaskLabelsControl task={task} />` and nothing else.
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { useLiveQuery } from '@tanstack/react-db'
import type { ReactElement, RefObject } from 'react'
import { toast } from 'sonner'

import { LaborerClient } from '@/atoms/laborer-client'
import {
  clearTaskLabelOverlayAtom,
  installTaskLabelOverlayAtom,
} from '@/atoms/legacy-shared-state-writes'
import {
  labelCollection,
  labelsForIds,
  orderedLabelsFromRows,
} from '@/db/shared-state'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'

import { type TaskLabelOption, TaskLabelsPillTrigger } from './label-chips'
import { LabelsPicker } from './labels-picker'

const createLabelMutation = LaborerClient.mutation('label.create')
const setTaskLabelsMutation = LaborerClient.mutation('task.labels.set')

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
  const { data: labelRows } = useLiveQuery((query) =>
    query.from({ labels: labelCollection })
  )
  const options: readonly TaskLabelOption[] = orderedLabelsFromRows(labelRows)
  const selected: readonly TaskLabelOption[] = labelsForIds(
    task.labelIds,
    labelRows
  )
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
