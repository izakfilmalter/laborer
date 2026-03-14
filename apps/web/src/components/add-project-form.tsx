/**
 * Add Project button / form component.
 *
 * In the Electron desktop shell, opens the native OS folder picker via
 * the DesktopBridge. In a plain browser (e.g., during E2E tests), renders
 * a text input where the user can type or paste a repository path.
 *
 * Both paths call the `project.add` mutation with the selected/entered
 * directory path.
 *
 * Success: project appears in the list (via LiveStore), toast shown.
 * Error: server validation error displayed in a toast.
 *
 * @see Issue #27: Add Project form
 */

import { useAtomSet } from '@effect-atom/atom-react/Hooks'
import { FolderPlus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { LaborerClient } from '@/atoms/laborer-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getDesktopBridge, isElectron } from '@/lib/desktop'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'

const addProjectMutation = LaborerClient.mutation('project.add')

function AddProjectForm() {
  const [isAdding, setIsAdding] = useState(false)
  const [repoPath, setRepoPath] = useState('')
  const addProject = useAtomSet(addProjectMutation, { mode: 'promise' })

  const submitProject = async (path: string) => {
    setIsAdding(true)
    try {
      const result = await addProject({
        payload: { repoPath: path },
      })
      toast.success(`Project "${result.name}" added`)
      setRepoPath('')
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(message)
    } finally {
      setIsAdding(false)
    }
  }

  const handleDesktopClick = async () => {
    try {
      const bridge = getDesktopBridge()
      if (!bridge) {
        return
      }
      const selected = await bridge.pickFolder()

      if (!selected) {
        return
      }

      await submitProject(selected)
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(message)
    }
  }

  const handleBrowserSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = repoPath.trim()
    if (trimmed.length === 0) {
      return
    }
    submitProject(trimmed).catch(() => {
      // submitProject already reports failures via toast
    })
  }

  if (isElectron()) {
    return (
      <Button
        disabled={isAdding}
        onClick={handleDesktopClick}
        size="sm"
        variant="outline"
      >
        <FolderPlus className="size-3.5" />
        {isAdding ? 'Adding...' : 'Add Project'}
      </Button>
    )
  }

  return (
    <form className="flex items-center gap-1" onSubmit={handleBrowserSubmit}>
      <Input
        aria-label="Repository path"
        disabled={isAdding}
        onChange={(event) => setRepoPath(event.target.value)}
        placeholder="/path/to/git/repo"
        type="text"
        value={repoPath}
      />
      <Button
        disabled={isAdding || repoPath.trim().length === 0}
        size="sm"
        type="submit"
        variant="outline"
      >
        <FolderPlus className="size-3.5" />
        {isAdding ? 'Adding...' : 'Add'}
      </Button>
    </form>
  )
}

export { AddProjectForm }
