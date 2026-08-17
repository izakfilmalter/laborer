/**
 * The Labels settings table, connected to shared state.
 *
 * Labels are app-wide, so this section reads, writes, and counts against every
 * label and every task there is. `LabelSettings` renders it.
 */

import { useAtomSet, useAtomValue } from '@effect/atom-react/Hooks'
import { useLiveQuery } from '@tanstack/react-db'
import type { ReactElement } from 'react'
import { useMemo, useState } from 'react'

import { LaborerClient } from '@/atoms/laborer-client'
import { taskRowsAtom } from '@/atoms/shared-state'
import { labelCollection } from '@/db/shared-state'
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
  const stored = useMemo(
    () =>
      [...labelRows].sort((left, right) => left.name.localeCompare(right.name)),
    [labelRows]
  )
  const tasks = useAtomValue(taskRowsAtom)
  const createLabel = useAtomSet(createLabelMutation, { mode: 'promise' })
  const updateLabel = useAtomSet(updateLabelMutation, { mode: 'promise' })
  const deleteLabel = useAtomSet(deleteLabelMutation, { mode: 'promise' })
  const [error, setError] = useState<string | null>(null)

  // A label can be carried by tasks in any project, so the count spans them.
  const taskCounts = new Map<string, number>()
  for (const task of tasks) {
    for (const labelId of task.labelIds) {
      taskCounts.set(labelId, (taskCounts.get(labelId) ?? 0) + 1)
    }
  }

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
          createLabel({
            payload: { name, operationId: crypto.randomUUID() },
          })
        )
      }}
      onDelete={(label) => {
        const expectedRevision = revisionOf(label.id)
        if (expectedRevision === undefined) {
          return
        }
        run(() =>
          deleteLabel({
            payload: {
              expectedRevision,
              labelId: label.id,
              operationId: crypto.randomUUID(),
            },
          })
        )
      }}
      onRecolor={(label, color) => {
        const expectedRevision = revisionOf(label.id)
        if (expectedRevision === undefined) {
          return
        }
        run(() =>
          updateLabel({
            payload: {
              color,
              expectedRevision,
              labelId: label.id,
              operationId: crypto.randomUUID(),
            },
          })
        )
      }}
      onRename={(label, name) => {
        const expectedRevision = revisionOf(label.id)
        if (expectedRevision === undefined) {
          return
        }
        run(() =>
          updateLabel({
            payload: {
              expectedRevision,
              labelId: label.id,
              name,
              operationId: crypto.randomUUID(),
            },
          })
        )
      }}
    />
  )
}
