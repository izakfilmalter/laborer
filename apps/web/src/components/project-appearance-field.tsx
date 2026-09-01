/**
 * Accent and icon controls for a project.
 *
 * Appearance is stored on the project row rather than in `laborer.json`, so
 * these controls write on click instead of waiting for the settings form's
 * save — the swatch you press is the swatch you get, everywhere, at once.
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { PROJECT_COLORS } from '@laborer/shared/project-colors'
import type { ProjectColor } from '@laborer/shared/rpc'
import { Button } from '@laborer/ui/components/button'
import {
  Field,
  FieldDescription,
  FieldLabel,
} from '@laborer/ui/components/field'
import { cn } from '@laborer/ui/lib/utils'
import { useLiveQuery } from '@tanstack/react-db'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { ProjectIcon } from '@/components/project-icon'
import { setProjectColor as setProjectColorOptimistically } from '@/db/shared-mutations'
import { projectCollection } from '@/db/shared-state'
import { extractErrorMessage } from '@/lib/errors'
import {
  projectColorDotClassName,
  projectColorToken,
} from '@/lib/project-accent'
import { toast } from '@/lib/toast'

const setColorMutation = LaborerClient.mutation('project.setColor')
const refreshIconMutation = LaborerClient.mutation('project.refreshIcon')

function ProjectAppearanceField({
  projectId,
  projectName,
}: {
  readonly projectId: string
  readonly projectName: string
}) {
  const { data: projects } = useLiveQuery((query) =>
    query.from({ projects: projectCollection })
  )
  const project = projects.find((candidate) => candidate.id === projectId)
  const setColor = useAtomSet(setColorMutation, { mode: 'promise' })
  const refreshIcon = useAtomSet(refreshIconMutation, { mode: 'promise' })
  const [isRefreshing, setIsRefreshing] = useState(false)

  if (project === undefined) {
    return null
  }

  const selected = projectColorToken(project)

  const chooseColor = (color: ProjectColor) => {
    if (color === selected) {
      return
    }
    setProjectColorOptimistically({
      color,
      operationId: globalThis.crypto.randomUUID(),
      projectId,
      send: (payload) => setColor({ payload }),
    }).catch((error: unknown) => {
      toast.error(extractErrorMessage(error))
    })
  }

  const rediscoverIcon = () => {
    setIsRefreshing(true)
    refreshIcon({
      payload: { operationId: globalThis.crypto.randomUUID(), projectId },
    })
      .then((row) => {
        toast.success(
          row.iconDataUrl === null
            ? 'No favicon found in this repository'
            : 'Project icon updated'
        )
      })
      .catch((error: unknown) => {
        toast.error(extractErrorMessage(error))
      })
      .finally(() => {
        setIsRefreshing(false)
      })
  }

  return (
    <Field>
      <FieldLabel>Appearance</FieldLabel>
      <div className="flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          <ProjectIcon className="size-4" project={project} />
        </div>
        <fieldset className="flex flex-wrap gap-1.5 border-0 p-0">
          <legend className="sr-only">{`Accent color for ${projectName}`}</legend>
          {PROJECT_COLORS.map((color) => (
            <label className="cursor-pointer" key={color}>
              <input
                checked={color === selected}
                className="peer sr-only"
                data-testid={`project-color-${color}`}
                name={`project-color-${projectId}`}
                onChange={() => {
                  chooseColor(color)
                }}
                type="radio"
                value={color}
              />
              <span className="sr-only">{color}</span>
              <span
                aria-hidden="true"
                className={cn(
                  'block size-5 rounded-full opacity-70 ring-offset-2 ring-offset-background transition hover:opacity-100',
                  projectColorDotClassName(color),
                  'peer-checked:opacity-100 peer-checked:ring-2 peer-checked:ring-foreground',
                  'peer-focus-visible:ring-2 peer-focus-visible:ring-ring'
                )}
              />
            </label>
          ))}
        </fieldset>
      </div>
      <FieldDescription className="flex items-center gap-2 text-[11px] text-muted-foreground/70 leading-tight">
        <span className="flex-1">
          The accent marks this project in the sidebar and on the header of
          every workspace open under it. The icon is the favicon found in the
          repository.
        </span>
        <Button
          data-testid="project-refresh-icon"
          disabled={isRefreshing}
          onClick={rediscoverIcon}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw
            className={cn('size-3.5', isRefreshing && 'animate-spin')}
          />
          Find icon
        </Button>
      </FieldDescription>
    </Field>
  )
}

export { ProjectAppearanceField }
