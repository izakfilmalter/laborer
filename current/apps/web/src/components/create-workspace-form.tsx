/**
 * Create Sub-workspace form component.
 *
 * A dialog with a TanStack Form for creating a workspace that branches off an
 * existing one. Fields: a single optional input (autofocused on open) that
 * accepts either a branch name or a Slack message/thread URL — the form detects
 * which one was entered and switches behavior accordingly.
 * The dialog closes immediately on submit while a temporary workspace item shows
 * Slack analysis and creation progress in the project sidebar. Success and failure
 * are reported with toasts after the background request completes.
 *
 * Creating a workspace at the project level is an inline sidebar composer
 * instead — see `create-workspace-composer.tsx`.
 *
 * @see Issue #42: Create Workspace form
 * @see Issue #49: Workspace creation error display
 * @see Issue #121: Loading state — workspace creation
 * @see Issue #169: Per-project "+" button and CreateWorkspaceForm pre-selection
 */

import { useForm } from '@tanstack/react-form'
import { GitBranch, Layers, Slack } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useId, useState } from 'react'
import { IMaskInput } from 'react-imask'
import { LifecyclePhase } from '@/components/lifecycle-phase-context'
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
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { inputClassName } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import {
  ALLOWED_INPUT_PATTERN,
  isSlackUrlInput,
  type PendingWorkspaceCreationChangeHandler,
  type PendingWorkspaceCreationPhase,
  toBranchName,
  useCreateWorkspace,
} from '@/hooks/use-create-workspace'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { toast } from '@/lib/toast'
import { cn, extractErrorMessage } from '@/lib/utils'

/** Strips the border/ring so the input blends into its InputGroup wrapper. */
const inputGroupControlClassName =
  'flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent'

interface CreateWorkspaceFormProps {
  /**
   * When set, creates a sub-workspace: the new worktree branches from this
   * workspace's current HEAD and its PR targets this workspace's branch.
   */
  readonly baseWorkspace?:
    | { readonly id: string; readonly branchName: string }
    | undefined
  /** Reports temporary sidebar state while creation runs after the dialog closes. */
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  /** The project to create a workspace in. */
  readonly projectId: string
  /** The project name shown in the sidebar. */
  readonly projectName: string
  /** Custom trigger element. Defaults to a "Create Workspace" button. */
  readonly trigger?: ReactNode | undefined
}

function CreateWorkspaceForm({
  baseWorkspace,
  onPendingCreationChange,
  projectId,
  projectName,
  trigger,
}: CreateWorkspaceFormProps) {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const descriptionId = useId()
  const [open, setOpen] = useState(false)
  const createWorkspace = useCreateWorkspace(onPendingCreationChange)
  const [submissionPhase, setSubmissionPhase] =
    useState<PendingWorkspaceCreationPhase | null>(null)
  const branchInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus()
    }
  }, [])

  const form = useForm({
    defaultValues: {
      branchNameOrSlackUrl: '',
    },
    onSubmit: async ({ value }) => {
      setOpen(false)

      try {
        // The RPC returns as soon as the workspace is accepted; the sidebar
        // card shows setup progress from there via worktreeSetupStep.
        const created = await createWorkspace({
          branchNameOrSlackUrl: value.branchNameOrSlackUrl,
          onPhaseChange: setSubmissionPhase,
          projectId,
          ...(baseWorkspace ? { baseWorkspaceId: baseWorkspace.id } : {}),
        })
        toast.success(
          created.fromSlack
            ? `Workspace "${created.branchName}" is being set up with its Slack prompt`
            : `Workspace "${created.branchName}" is being set up`
        )
      } catch (error: unknown) {
        toast.error(extractErrorMessage(error))
      } finally {
        form.reset()
      }
    },
  })

  return (
    <Dialog
      onOpenChange={(value) => {
        if (form.state.isSubmitting) {
          return
        }
        setOpen(value)
        if (value) {
          // Reset form when dialog opens
          form.reset({
            branchNameOrSlackUrl: '',
          })
        }
      }}
      open={open}
    >
      {trigger ?? (
        <DialogTrigger
          render={
            <Button
              disabled={!isServerReady}
              size="sm"
              title={isServerReady ? undefined : 'Connecting to server...'}
              variant="outline"
            />
          }
        >
          <Layers className="size-3.5" />
          {isServerReady ? 'Create Workspace' : 'Connecting...'}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {baseWorkspace ? 'Create Sub-workspace' : 'Create Workspace'}
          </DialogTitle>
          <DialogDescription>
            {baseWorkspace ? (
              <>
                Branch off{' '}
                <span className="font-mono text-foreground">
                  {baseWorkspace.branchName}
                </span>
                . The new workspace starts at its current commit and its PR
                targets that branch.
              </>
            ) : (
              'Create an isolated git worktree for a piece of work. Each workspace gets its own branch, port, and directory.'
            )}
          </DialogDescription>
        </DialogHeader>
        {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: Cmd+Enter keyboard shortcut to submit the form */}
        <form
          onKeyDown={(e) => {
            // Allow Cmd+Enter to submit (in addition to plain Enter)
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              form.handleSubmit()
            }
          }}
          onSubmit={(e) => {
            e.preventDefault()
            e.stopPropagation()
            form.handleSubmit()
          }}
        >
          <div className="grid gap-4 py-2">
            <form.Field name="branchNameOrSlackUrl">
              {(field) => {
                const isSlackMode = isSlackUrlInput(field.state.value)

                return (
                  <Field>
                    <FieldLabel htmlFor="branchNameOrSlackUrl">
                      Branch Name or Slack URL (optional)
                    </FieldLabel>
                    <InputGroup>
                      <InputGroupAddon>
                        {isSlackMode ? (
                          <Slack aria-hidden="true" className="size-3.5" />
                        ) : (
                          <GitBranch aria-hidden="true" className="size-3.5" />
                        )}
                      </InputGroupAddon>
                      <IMaskInput
                        aria-describedby={descriptionId}
                        className={cn(
                          inputClassName,
                          inputGroupControlClassName
                        )}
                        data-slot="input-group-control"
                        disabled={form.state.isSubmitting}
                        id="branchNameOrSlackUrl"
                        inputRef={branchInputRef}
                        mask={ALLOWED_INPUT_PATTERN}
                        name={field.name}
                        onAccept={(value) => field.handleChange(value)}
                        onBlur={field.handleBlur}
                        placeholder={`${projectName}/my-feature or a Slack URL`}
                        prepare={(str, masked) =>
                          isSlackUrlInput(`${masked.value}${str}`)
                            ? str
                            : toBranchName(str)
                        }
                        value={field.state.value}
                      />
                    </InputGroup>
                    <FieldDescription id={descriptionId}>
                      {isSlackMode
                        ? 'OpenCode will read the conversation, name the workspace, and start with a self-contained prompt.'
                        : 'Leave empty to auto-generate a branch name, or paste a Slack message or thread URL to build the workspace from that conversation.'}
                    </FieldDescription>
                  </Field>
                )
              }}
            </form.Field>
          </div>

          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, isSubmitting]) => (
              <DialogFooter>
                <Button
                  disabled={!(isServerReady && canSubmit) || isSubmitting}
                  type="submit"
                >
                  {isSubmitting && (
                    <>
                      <Spinner className="size-3.5" />
                      {submissionPhase === 'analyzing'
                        ? 'Reading Slack...'
                        : 'Creating...'}
                    </>
                  )}
                  {!isSubmitting && 'Create Workspace'}
                  {!isSubmitting && <Kbd>↵</Kbd>}
                </Button>
              </DialogFooter>
            )}
          </form.Subscribe>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { CreateWorkspaceForm }
export type { CreateWorkspaceFormProps }
