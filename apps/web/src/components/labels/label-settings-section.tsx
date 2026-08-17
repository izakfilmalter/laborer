/**
 * The Labels settings table, connected to shared state.
 *
 * Labels are app-wide, so this section reads, writes, and counts against every
 * label and every task there is. `LabelSettings` renders it.
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { createTaskUlid } from '@laborer/task-db/ulid'
import { useLiveQuery } from '@tanstack/react-db'
import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'

import { LaborerClient } from '@/atoms/laborer-client'
import {
  createLabel as createLabelOptimistically,
  deleteLabel as deleteLabelOptimistically,
  updateLabel as updateLabelOptimistically,
} from '@/db/shared-mutations'
import {
  labelCollection,
  orderedLabelsFromRows,
  taskCollection,
  taskCountsByLabel,
} from '@/db/shared-state'
import { extractErrorCode, extractErrorMessage } from '@/lib/errors'

import { LabelSettings, type LabelSettingsRow } from './label-settings'

const createLabelMutation = LaborerClient.mutation('label.create')
const updateLabelMutation = LaborerClient.mutation('label.update')
const deleteLabelMutation = LaborerClient.mutation('label.delete')

/**
 * A rejected write reads as one sentence above the table. A CAS conflict is
 * the one failure worth naming, because it means the label changed elsewhere
 * rather than that the write was wrong.
 */
const writeFailureMessage = (error: unknown): string =>
  extractErrorCode(error) === 'CAS_CONFLICT'
    ? 'This label changed elsewhere. It is shown as stored — try again.'
    : extractErrorMessage(error)

export function LabelSettingsSection(): ReactElement {
  const { data: labelRows } = useLiveQuery((query) =>
    query.from({ labels: labelCollection })
  )
  const { data: tasks } = useLiveQuery((query) =>
    query.from({ tasks: taskCollection })
  )
  const stored = useMemo(() => orderedLabelsFromRows(labelRows), [labelRows])
  const createLabel = useAtomSet(createLabelMutation, { mode: 'promise' })
  const updateLabel = useAtomSet(updateLabelMutation, { mode: 'promise' })
  const deleteLabel = useAtomSet(deleteLabelMutation, { mode: 'promise' })
  const [error, setError] = useState<string | null>(null)

  // A label can be carried by tasks in any project, so the count spans them.
  const taskCounts = taskCountsByLabel(tasks)

  const labels: readonly LabelSettingsRow[] = stored.map((label) => ({
    color: label.color,
    createdAt: label.createdAt,
    id: label.id,
    name: label.name,
    taskCount: taskCounts.get(label.id) ?? 0,
  }))

  const revisionOf = (labelId: string): number | undefined =>
    stored.find(({ id }) => id === labelId)?.revision

  const run = (write: () => Promise<unknown>) => {
    setError(null)
    write().catch((cause: unknown) => {
      setError(writeFailureMessage(cause))
    })
  }

  return (
    <LabelSettings
      error={error}
      labels={labels}
      onCreate={(name) => {
        run(() =>
          createLabelOptimistically({
            id: createTaskUlid(),
            name,
            operationId: crypto.randomUUID(),
            send: (payload) => createLabel({ payload }),
          })
        )
      }}
      onDelete={(label) => {
        const expectedRevision = revisionOf(label.id)
        if (expectedRevision === undefined) {
          return
        }
        run(() =>
          deleteLabelOptimistically({
            labelId: label.id,
            operationId: crypto.randomUUID(),
            send: (payload) => deleteLabel({ payload }),
          })
        )
      }}
      onRecolor={(label, color) => {
        const expectedRevision = revisionOf(label.id)
        if (expectedRevision === undefined) {
          return
        }
        run(() =>
          updateLabelOptimistically({
            color,
            labelId: label.id,
            operationId: crypto.randomUUID(),
            send: (payload) => updateLabel({ payload }),
          })
        )
      }}
      onRename={(label, name) => {
        const expectedRevision = revisionOf(label.id)
        if (expectedRevision === undefined) {
          return
        }
        run(() =>
          updateLabelOptimistically({
            labelId: label.id,
            name,
            operationId: crypto.randomUUID(),
            send: (payload) => updateLabel({ payload }),
          })
        )
      }}
    />
  )
}
