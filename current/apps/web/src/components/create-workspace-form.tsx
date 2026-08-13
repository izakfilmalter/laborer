/**
 * Create Workspace form component.
 *
 * A dialog with a TanStack Form for creating a new workspace.
 * Fields: a single optional input (autofocused on open) that accepts either a
 * branch name or a Slack message/thread URL — the form detects which one was
 * entered and switches behavior accordingly.
 * On submit, calls the `workspace.create` mutation via AtomRpc.
 * The dialog closes immediately on submit while a temporary workspace item shows
 * Slack analysis and creation progress in the project sidebar. Success and failure
 * are reported with toasts after the background request completes.
 *
 * @see Issue #42: Create Workspace form
 * @see Issue #49: Workspace creation error display
 * @see Issue #121: Loading state — workspace creation
 * @see Issue #169: Per-project "+" button and CreateWorkspaceForm pre-selection
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { useForm } from '@tanstack/react-form'
import { pipe, String as Str } from 'effect'
import { GitBranch, Layers, Slack } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useId, useState } from 'react'
import { IMaskInput } from 'react-imask'
import { LaborerClient } from '@/atoms/laborer-client'
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
import { useWhenPhase } from '@/hooks/use-when-phase'
import { toast } from '@/lib/toast'
import { cn, extractErrorMessage } from '@/lib/utils'
import { usePanelActions } from '@/panels/panel-context'

const createWorkspaceMutation = LaborerClient.mutation('workspace.create')
const planSlackWorkspaceMutation = LaborerClient.mutation(
  'workspace.planFromSlack'
)

/** Characters the combined input accepts: branch-safe characters plus URL syntax. */
const ALLOWED_INPUT_PATTERN = /^[a-zA-Z0-9\s\-_/.:?=&#%~+@]*$/
const BRANCH_UNSAFE_PATTERN = /[^a-z0-9\-_/.]/g
const HTTP_SCHEME_PATTERN = /^https?:\/\//i
const URL_SCHEMES = ['https://', 'http://']
/** Below this length a value is still ambiguous with a branch name like "ht". */
const MIN_SCHEME_PREFIX_LENGTH = 4

/**
 * True when the value should be treated as a Slack URL rather than a branch
 * name. Partial schemes ("http", "https:/") count so that normalization stops
 * mangling the value while a URL is still being typed.
 */
const isSlackUrlInput = (value: string): boolean => {
  const candidate = value.trim().toLowerCase()
  if (candidate === '') {
    return false
  }
  return (
    HTTP_SCHEME_PATTERN.test(candidate) ||
    candidate.includes('slack.com') ||
    (candidate.length >= MIN_SCHEME_PREFIX_LENGTH &&
      URL_SCHEMES.some((scheme) => scheme.startsWith(candidate)))
  )
}

/** Slack URLs pasted without a scheme still need one for the planner. */
const toSlackUrl = (value: string): string =>
  HTTP_SCHEME_PATTERN.test(value) ? value : `https://${value}`

const toBranchName = (value: string): string =>
  pipe(
    value,
    Str.toLowerCase,
    Str.replaceAll(' ', '-'),
    Str.replace(BRANCH_UNSAFE_PATTERN, '')
  )

/** Strips the border/ring so the input blends into its InputGroup wrapper. */
const inputGroupControlClassName =
  'flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent'

type PendingWorkspaceCreationPhase = 'analyzing' | 'creating'

interface PendingWorkspaceCreation {
  readonly branchName: string | null
  readonly id: string
  readonly phase: PendingWorkspaceCreationPhase
}

type PendingWorkspaceCreationChangeHandler = (change: {
  readonly creation: PendingWorkspaceCreation | null
  readonly id: string
}) => void

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
  const panelActions = usePanelActions()
  const pendingCreationId = useId()
  const descriptionId = useId()
  const [open, setOpen] = useState(false)
  const createWorkspace = useAtomSet(createWorkspaceMutation, {
    mode: 'promise',
  })
  const planSlackWorkspace = useAtomSet(planSlackWorkspaceMutation, {
    mode: 'promise',
  })
  const [submissionPhase, setSubmissionPhase] = useState<
    'analyzing' | 'creating' | null
  >(null)
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
      const entered = value.branchNameOrSlackUrl.trim()
      const slackUrl = isSlackUrlInput(entered) ? toSlackUrl(entered) : ''
      let branchName = slackUrl ? '' : entered
      let initialPrompt: string | undefined
      const initialPhase: PendingWorkspaceCreationPhase = slackUrl
        ? 'analyzing'
        : 'creating'

      setSubmissionPhase(initialPhase)
      onPendingCreationChange?.({
        creation: {
          branchName: branchName || null,
          id: pendingCreationId,
          phase: initialPhase,
        },
        id: pendingCreationId,
      })
      setOpen(false)

      try {
        if (slackUrl) {
          const plan = await planSlackWorkspace({
            payload: { slackUrl },
          })
          branchName = plan.branchName
          initialPrompt = plan.initialPrompt
          onPendingCreationChange?.({
            creation: {
              branchName,
              id: pendingCreationId,
              phase: 'creating',
            },
            id: pendingCreationId,
          })
        }

        setSubmissionPhase('creating')
        const result = await createWorkspace({
          payload: {
            projectId,
            ...(branchName ? { branchName } : {}),
            ...(baseWorkspace ? { baseWorkspaceId: baseWorkspace.id } : {}),
          },
        })
        if (initialPrompt === undefined) {
          panelActions?.autoOpenAgentWhenWorkspaceReady?.(result.id)
        } else {
          panelActions?.autoOpenAgentWhenWorkspaceReady?.(result.id, {
            initialPrompt,
          })
        }
        // The RPC now returns immediately with status 'creating'.
        // The workspace card will show setup progress via worktreeSetupStep.
        toast.success(
          slackUrl
            ? `Workspace "${result.branchName}" is being set up with its Slack prompt`
            : `Workspace "${result.branchName}" is being set up`
        )
      } catch (error: unknown) {
        const message = extractErrorMessage(error)
        toast.error(message)
      } finally {
        onPendingCreationChange?.({
          creation: null,
          id: pendingCreationId,
        })
        form.reset()
        setSubmissionPhase(null)
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
export type {
  CreateWorkspaceFormProps,
  PendingWorkspaceCreation,
  PendingWorkspaceCreationChangeHandler,
}
