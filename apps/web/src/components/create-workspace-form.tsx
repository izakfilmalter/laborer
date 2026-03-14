/**
 * Create Workspace form component.
 *
 * A dialog with a TanStack Form for creating a new workspace.
 * Fields: optional branch name (autofocused on open).
 * On submit, calls the `workspace.create` mutation via AtomRpc.
 * Shows a loading state with spinner and indeterminate progress bar
 * during workspace creation (worktree creation, port allocation,
 * setup script execution). Dialog cannot be dismissed during submission.
 * Success: workspace appears in the list (via LiveStore), form resets, dialog closes.
 * Error: displays an inline alert within the dialog with a distinct, actionable
 * message for each error type (git fetch failure, setup script
 * failure, branch conflict, worktree failure). Also shows a toast for persistence
 * after the dialog is closed.
 *
 * @see Issue #42: Create Workspace form
 * @see Issue #49: Workspace creation error display
 * @see Issue #121: Loading state — workspace creation
 * @see Issue #169: Per-project "+" button and CreateWorkspaceForm pre-selection
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { useForm } from '@tanstack/react-form'
import { pipe, String as Str } from 'effect'
import { AlertTriangle, Layers, ScrollText, WifiOff, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useState } from 'react'
import { IMaskInput } from 'react-imask'
import { LaborerClient } from '@/atoms/laborer-client'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { Kbd } from '@/components/ui/kbd'
import { Spinner } from '@/components/ui/spinner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { toast } from '@/lib/toast'
import { extractErrorCode, extractErrorMessage } from '@/lib/utils'

const createWorkspaceMutation = LaborerClient.mutation('workspace.create')

/** Structured error info for workspace creation failures. */
interface WorkspaceCreationError {
  /** The error code from the RPC response, if available. */
  code: string | undefined
  /** The human-readable error message. */
  message: string
}

/**
 * Returns a short, user-friendly title for a workspace creation error code.
 * Used as the inline alert heading.
 */
function getErrorTitle(code: string | undefined): string {
  switch (code) {
    case 'GIT_FETCH_FAILED':
      return 'Network Error'
    case 'SETUP_SCRIPT_FAILED':
      return 'Setup Script Failed'
    case 'GIT_WORKTREE_FAILED':
      return 'Worktree Creation Failed'
    case 'WORKTREE_VERIFY_FAILED':
      return 'Worktree Verification Failed'
    case 'FILESYSTEM_ERROR':
      return 'Filesystem Error'
    case 'GIT_CHECK_FAILED':
      return 'Git Check Failed'
    case 'GIT_REV_PARSE_FAILED':
      return 'Git Error'
    case 'NO_PORTS_AVAILABLE':
      return 'No Ports Available'
    default:
      return 'Workspace Creation Failed'
  }
}

/**
 * Returns a concise, actionable guidance string for a workspace creation error.
 * This supplements the server's error message with a clear next step.
 */
function getErrorGuidance(code: string | undefined): string | undefined {
  switch (code) {
    case 'GIT_FETCH_FAILED':
      return 'Check your network connection and remote repository access, then try again.'
    case 'SETUP_SCRIPT_FAILED':
      return "Check the setup scripts in your project's laborer.json file and fix the failing script."
    case 'GIT_WORKTREE_FAILED':
      return 'This may indicate a conflict with an existing worktree. Check your git worktree list.'
    case 'NO_PORTS_AVAILABLE':
      return 'Destroy some existing workspaces to free up ports.'
    default:
      return undefined
  }
}

/**
 * Returns the appropriate icon for a workspace creation error code.
 */
function getErrorIcon(code: string | undefined) {
  switch (code) {
    case 'GIT_FETCH_FAILED':
      return <WifiOff className="size-4" />
    case 'SETUP_SCRIPT_FAILED':
      return <ScrollText className="size-4" />
    default:
      return <AlertTriangle className="size-4" />
  }
}

interface CreateWorkspaceFormProps {
  /** The project to create a workspace in. */
  readonly projectId: string
  /** Custom trigger element. Defaults to a "Create Workspace" button. */
  readonly trigger?: ReactNode | undefined
}

function CreateWorkspaceForm({ projectId, trigger }: CreateWorkspaceFormProps) {
  const [open, setOpen] = useState(false)
  const [creationError, setCreationError] =
    useState<WorkspaceCreationError | null>(null)
  const createWorkspace = useAtomSet(createWorkspaceMutation, {
    mode: 'promise',
  })
  const branchInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus()
    }
  }, [])

  const clearError = useCallback(() => {
    setCreationError(null)
  }, [])

  const form = useForm({
    defaultValues: {
      branchName: '',
    },
    onSubmit: async ({ value }) => {
      // Clear any previous error when retrying
      setCreationError(null)
      try {
        // Replace forward slashes with hyphens so the branch name
        // is safe as a directory name on the filesystem.
        const sanitized = pipe(
          value.branchName.trim(),
          Str.replaceAll('/', '-')
        )
        const result = await createWorkspace({
          payload: {
            projectId,
            ...(sanitized ? { branchName: sanitized } : {}),
          },
        })
        // The RPC now returns immediately with status 'creating'.
        // The workspace card will show setup progress via worktreeSetupStep.
        toast.success(
          `Workspace "${result.branchName}" is being set up (port ${result.port})`
        )
        form.reset()
        setOpen(false)
      } catch (error: unknown) {
        const message = extractErrorMessage(error)
        const code = extractErrorCode(error)
        setCreationError({ code, message })
        toast.error(message)
      }
    },
  })

  return (
    <Dialog
      onOpenChange={(value) => {
        // Prevent closing dialog while workspace is being created
        if (!form.state.isSubmitting) {
          setOpen(value)
          if (value) {
            // Reset form when dialog opens
            form.reset({
              branchName: '',
            })
          }
          if (!value) {
            setCreationError(null)
          }
        }
      }}
      open={open}
    >
      {trigger ?? (
        <DialogTrigger render={<Button size="sm" variant="outline" />}>
          <Layers className="size-3.5" />
          Create Workspace
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Workspace</DialogTitle>
          <DialogDescription>
            Create an isolated git worktree for an agent or task. Each workspace
            gets its own branch, port, and directory.
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
            <form.Field name="branchName">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor="branchName">
                    Branch Name (optional)
                  </FieldLabel>
                  <IMaskInput
                    className={inputClassName}
                    disabled={form.state.isSubmitting}
                    id="branchName"
                    inputRef={branchInputRef}
                    // biome-ignore lint/performance/useTopLevelRegex: required inline for IMaskInput
                    mask={/^[a-zA-Z0-9\s\-_/]*$/}
                    name={field.name}
                    onAccept={(value) => field.handleChange(value)}
                    onBlur={field.handleBlur}
                    placeholder="laborer/my-feature"
                    prepare={(str) =>
                      pipe(str, Str.toLowerCase, Str.replaceAll(' ', '-'))
                    }
                    value={field.state.value}
                  />
                  <FieldDescription>
                    Leave empty to auto-generate a branch name.
                  </FieldDescription>
                </Field>
              )}
            </form.Field>
          </div>

          {creationError && (
            <WorkspaceErrorAlert error={creationError} onDismiss={clearError} />
          )}

          <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting]}
          >
            {([canSubmit, isSubmitting]) => (
              <DialogFooter>
                <Button disabled={!canSubmit || isSubmitting} type="submit">
                  {isSubmitting && (
                    <>
                      <Spinner className="size-3.5" />
                      Creating...
                    </>
                  )}
                  {!isSubmitting && creationError && 'Retry'}
                  {!(isSubmitting || creationError) && 'Create Workspace'}
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

/**
 * Inline alert component for workspace creation errors.
 * Shows a distinct title, icon, and actionable guidance for each error type.
 */
function WorkspaceErrorAlert({
  error,
  onDismiss,
}: {
  error: WorkspaceCreationError
  onDismiss: () => void
}) {
  const title = getErrorTitle(error.code)
  const guidance = getErrorGuidance(error.code)
  const icon = getErrorIcon(error.code)

  return (
    <Alert className="relative my-2" variant="destructive">
      {icon}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {guidance && (
          <p className="mt-1 font-medium text-destructive">{guidance}</p>
        )}
      </AlertDescription>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-label="Dismiss error"
              className="absolute top-2 right-2 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              onClick={onDismiss}
              type="button"
            />
          }
        >
          <X className="size-3.5" />
        </TooltipTrigger>
        <TooltipContent>Dismiss</TooltipContent>
      </Tooltip>
    </Alert>
  )
}

export { CreateWorkspaceForm }
export type { CreateWorkspaceFormProps }
