/**
 * Fix Findings form component.
 *
 * A dialog with a TanStack Form for fixing review findings on a pull request
 * in a workspace. Fields: PR number input (required, must be a positive integer).
 * On submit, calls the `rlph.fix` mutation via AtomRpc, which spawns a terminal
 * running `rlph fix <prNumber>` in the workspace. The spawned terminal is
 * auto-assigned to a panel pane so the user immediately sees the rlph TUI output
 * in xterm.js.
 *
 * @see Issue #99: "Fix Findings" button + PR number input
 * @see Issue #98: rlph.fix RPC handler
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { useForm } from '@tanstack/react-form'
import { Wrench } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { extractErrorMessage } from '@/lib/utils'
import { usePanelActions } from '@/panels/panel-context'

const fixFindingsMutation = LaborerClient.mutation('rlph.fix')

interface FixFindingsFormProps {
  readonly onTerminalSpawned?: () => void
  readonly workspaceId: string
}

function FixFindingsForm({
  workspaceId,
  onTerminalSpawned,
}: FixFindingsFormProps) {
  const [open, setOpen] = useState(false)
  const fixFindings = useAtomSet(fixFindingsMutation, { mode: 'promise' })
  const panelActions = usePanelActions()

  const form = useForm({
    defaultValues: {
      prNumber: '',
    },
    onSubmit: async ({ value }) => {
      try {
        const prNum = Number.parseInt(value.prNumber, 10)
        const result = await fixFindings({
          payload: {
            workspaceId,
            prNumber: prNum,
          },
        })
        toast.success(`Fix started for PR #${prNum}`)
        // Auto-assign the spawned terminal to a pane
        if (panelActions) {
          panelActions.assignTerminalToPane(result.id, workspaceId)
        }
        form.reset()
        setOpen(false)
        onTerminalSpawned?.()
      } catch (error: unknown) {
        const message = extractErrorMessage(error)
        toast.error(`Failed to start fix: ${message}`)
      }
    },
  })

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Tooltip>
        <TooltipTrigger
          render={
            <DialogTrigger
              render={
                <Button
                  aria-label="Fix Findings"
                  size="icon-xs"
                  variant="ghost"
                />
              }
            />
          }
        >
          <Wrench className="size-3.5 text-warning" />
        </TooltipTrigger>
        <TooltipContent>Fix Findings</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Fix Findings</DialogTitle>
          <DialogDescription>
            Enter the pull request number to fix review findings for. This will
            run{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              rlph fix &lt;pr&gt;
            </code>{' '}
            in the workspace to address checked review findings.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            form.handleSubmit()
          }}
        >
          <div className="grid gap-4 py-2">
            <form.Field
              name="prNumber"
              validators={{
                onChange: ({ value }) => {
                  if (!value.trim()) {
                    return 'PR number is required'
                  }
                  const num = Number.parseInt(value, 10)
                  if (Number.isNaN(num) || num <= 0) {
                    return 'PR number must be a positive integer'
                  }
                  if (!Number.isInteger(Number(value))) {
                    return 'PR number must be a whole number'
                  }
                  return undefined
                },
              }}
            >
              {(field) => (
                <Field data-invalid={field.state.meta.errors.length > 0}>
                  <FieldLabel>Pull Request Number</FieldLabel>
                  <Input
                    inputMode="numeric"
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    pattern="[0-9]*"
                    placeholder="e.g. 42"
                    type="text"
                    value={field.state.value}
                  />
                  <FieldDescription>
                    The number of the pull request with review findings to fix.
                  </FieldDescription>
                  {field.state.meta.isTouched &&
                    field.state.meta.errors.length > 0 && (
                      <FieldError>
                        {field.state.meta.errors.join(', ')}
                      </FieldError>
                    )}
                </Field>
              )}
            </form.Field>
          </div>
          <DialogFooter>
            <form.Subscribe
              selector={(state) => [state.canSubmit, state.isSubmitting]}
            >
              {([canSubmit, isSubmitting]) => (
                <Button disabled={!canSubmit || isSubmitting} type="submit">
                  {isSubmitting ? 'Starting...' : 'Fix Findings'}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { FixFindingsForm }
