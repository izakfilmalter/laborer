/**
 * The sidebar's workspace composer — the shared inline composer, configured
 * for branch names and Slack URLs.
 *
 * The project heading's "+" toggles it, exactly as the kanban board's column
 * header toggles its card composer. What is particular here: the text is
 * masked into a branch name as it is typed, an empty commit lets the server
 * auto-name the branch, and creation continues in the background as a pending
 * sidebar item.
 *
 * @see Issue #169: Per-project "+" button
 */

import { GitBranch, Slack } from 'lucide-react'
import { IMaskInput } from 'react-imask'
import {
  type ComposerCloseReason,
  ComposerToggleButton,
  InlineComposer,
} from '@/components/inline-composer'
import { inputClassName } from '@/components/ui/input'
import {
  ALLOWED_INPUT_PATTERN,
  createWorkspaceIntent,
  isSlackUrlInput,
  type PendingWorkspaceCreationChangeHandler,
  toBranchName,
  useCreateWorkspace,
} from '@/hooks/use-create-workspace'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/** Strips the border/ring so the masked input blends into its InputGroup. */
const inputGroupControlClassName =
  'flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent'

/** The project heading's "+", which toggles that project's composer. */
function CreateWorkspaceButton({
  composerId,
  disabled,
  id,
  onToggle,
  open,
  projectName,
}: {
  readonly composerId: string
  readonly disabled?: boolean | undefined
  readonly id: string
  readonly onToggle: () => void
  readonly open: boolean
  readonly projectName: string
}) {
  return (
    <ComposerToggleButton
      className="h-7 w-7"
      closedLabel="Create Workspace"
      composerId={composerId}
      disabled={disabled}
      id={id}
      label={`Create workspace in ${projectName}`}
      onToggle={onToggle}
      open={open}
      size="icon-sm"
      title={disabled ? 'Connecting to server...' : undefined}
    />
  )
}

function CreateWorkspaceComposer({
  composerId,
  onClose,
  onPendingCreationChange,
  projectId,
  projectName,
}: {
  readonly composerId: string
  readonly onClose: (reason: ComposerCloseReason) => void
  readonly onPendingCreationChange?:
    | PendingWorkspaceCreationChangeHandler
    | undefined
  readonly projectId: string
  readonly projectName: string
}) {
  const createWorkspace = useCreateWorkspace(onPendingCreationChange)

  return (
    <InlineComposer
      addon={(trimmed) => {
        const intent = createWorkspaceIntent(trimmed)
        return intent === 'slack' || intent === 'unrecognized-link' ? (
          <Slack aria-hidden="true" className="size-3.5" />
        ) : (
          <GitBranch aria-hidden="true" className="size-3.5" />
        )
      }}
      ariaLabel={`Branch name or Slack URL for ${projectName}`}
      commit={(trimmed) =>
        createWorkspace({ branchNameOrSlackUrl: trimmed, projectId })
      }
      // An empty commit is meaningful: the server names the branch.
      commitsEmpty
      commitsOnPaste={(trimmed) => createWorkspaceIntent(trimmed) === 'slack'}
      composerId={composerId}
      confirmation={(trimmed) =>
        createWorkspaceIntent(trimmed) === 'slack'
          ? 'Slack link added — reading the thread in the background.'
          : `Creating ${trimmed === '' ? 'an auto-named workspace' : `"${trimmed}"`}…`
      }
      hint={(trimmed) => {
        const intent = createWorkspaceIntent(trimmed)
        if (intent === 'slack') {
          return {
            className: 'text-muted-foreground',
            text: 'Slack link — OpenCode reads the thread, names the branch, and starts.',
          }
        }
        if (intent === 'unrecognized-link') {
          return {
            className: 'text-warning',
            text: 'Not a Slack message link yet — paste a message or thread permalink.',
          }
        }
        return null
      }}
      idleHint={(trimmed) =>
        trimmed === ''
          ? 'Enter for an auto-named branch · Esc to close'
          : 'Enter to create · Esc to close'
      }
      onClose={onClose}
      // Creation outlives the composer, so a late failure still needs a home.
      onFailureWhileClosed={toast.error}
      placeholder={`${projectName}/my-feature, or paste a Slack link`}
      renderControl={(control) => (
        <IMaskInput
          aria-describedby={control['aria-describedby']}
          aria-invalid={control['aria-invalid']}
          aria-label={control['aria-label']}
          className={cn(inputClassName, inputGroupControlClassName, 'text-xs')}
          data-slot="input-group-control"
          inputRef={control.ref}
          mask={ALLOWED_INPUT_PATTERN}
          onAccept={control.onValueChange}
          onBlur={control.onBlur}
          onKeyDown={control.onKeyDown}
          onPaste={control.onPaste}
          placeholder={control.placeholder}
          prepare={(str: string, masked: { value: string }) =>
            isSlackUrlInput(`${masked.value}${str}`) ? str : toBranchName(str)
          }
          value={control.value}
        />
      )}
    />
  )
}

export { CreateWorkspaceButton, CreateWorkspaceComposer }
