/**
 * Add Project button / form component.
 *
 * In the Electron desktop shell, opens the native OS folder picker via
 * the DesktopBridge. In a plain browser, opens a directory browser whose
 * contents come from the daemon host via RPC.
 *
 * Both paths call the `project.add` mutation with the selected/entered
 * directory path.
 *
 * Success: project appears through the shared-state stream, toast shown.
 * Error: server validation error displayed in a toast.
 *
 * @see Issue #27: Add Project form
 */

import { useAtomSet } from '@effect/atom-react/Hooks'
import { ChevronLeft, Folder, FolderPlus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
} from '@/components/ui/dialog'
import { useWhenPhase } from '@/hooks/use-when-phase'
import { localApi } from '@/lib/local-api'
import { toast } from '@/lib/toast'
import { extractErrorMessage } from '@/lib/utils'

const addProjectMutation = LaborerClient.mutation('project.add')
const listDirectoriesMutation = LaborerClient.mutation('local.directory.list')

interface DirectoryListing {
  readonly directories: readonly {
    readonly name: string
    readonly path: string
  }[]
  readonly parentPath: string | null
  readonly path: string
}

function BrowserDirectoryPicker({
  onCancel,
  onSelect,
  open,
}: {
  readonly onCancel: () => void
  readonly onSelect: (path: string) => void
  readonly open: boolean
}) {
  const listDirectories = useAtomSet(listDirectoriesMutation, {
    mode: 'promise',
  })
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const browse = useCallback(
    async (path?: string) => {
      setIsLoading(true)
      try {
        setListing(await listDirectories({ payload: { path } }))
      } catch (error: unknown) {
        toast.error(extractErrorMessage(error))
      } finally {
        setIsLoading(false)
      }
    },
    [listDirectories]
  )

  useEffect(() => {
    if (open) {
      browse().catch(() => undefined)
    } else {
      setListing(null)
    }
  }, [browse, open])

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onCancel()
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Choose a project folder</DialogTitle>
          <DialogDescription>
            Browse folders on the machine running the Laborer daemon.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-72 flex-col overflow-hidden rounded-lg border">
          <div className="flex items-center gap-2 border-b p-2">
            <Button
              aria-label="Go to parent folder"
              disabled={isLoading || listing?.parentPath === null || !listing}
              onClick={() => {
                if (listing?.parentPath) {
                  browse(listing.parentPath).catch(() => undefined)
                }
              }}
              size="icon-sm"
              variant="ghost"
            >
              <ChevronLeft />
            </Button>
            <span
              className="min-w-0 truncate font-mono text-xs"
              title={listing?.path}
            >
              {listing?.path ?? 'Loading…'}
            </span>
          </div>
          <div className="max-h-80 flex-1 overflow-y-auto p-1">
            {listing?.directories.map((directory) => (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                key={directory.path}
                onClick={() => browse(directory.path).catch(() => undefined)}
                onDoubleClick={() =>
                  browse(directory.path).catch(() => undefined)
                }
                type="button"
              >
                <Folder className="size-4 shrink-0" />
                <span className="truncate">{directory.name}</span>
              </button>
            ))}
            {!isLoading && listing?.directories.length === 0 && (
              <p className="p-4 text-center text-muted-foreground text-sm">
                No subfolders
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={onCancel} variant="outline">
            Cancel
          </Button>
          <Button
            disabled={!listing || isLoading}
            onClick={() => {
              if (listing) {
                onSelect(listing.path)
              }
            }}
          >
            Select folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Returns the appropriate button label based on server readiness and submission state. */
function addProjectLabel(
  isServerReady: boolean,
  isAdding: boolean,
  full?: boolean
): string {
  if (!isServerReady) {
    return 'Connecting...'
  }
  if (isAdding) {
    return 'Adding...'
  }
  return full ? 'Add Project' : 'Add'
}

function AddProjectForm() {
  const isServerReady = useWhenPhase(LifecyclePhase.Ready)
  const [isAdding, setIsAdding] = useState(false)
  const [browserPickerOpen, setBrowserPickerOpen] = useState(false)
  const browserPickerResolution = useRef<
    ((path: string | null) => void) | null
  >(null)
  const addProject = useAtomSet(addProjectMutation, { mode: 'promise' })

  const submitProject = async (path: string) => {
    setIsAdding(true)
    try {
      const result = await addProject({
        payload: { repoPath: path },
      })
      toast.success(`Project "${result.name}" added`)
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(message)
    } finally {
      setIsAdding(false)
    }
  }

  const openBrowserPicker = () =>
    new Promise<string | null>((resolve) => {
      browserPickerResolution.current = resolve
      setBrowserPickerOpen(true)
    })

  const resolveBrowserPicker = (path: string | null) => {
    browserPickerResolution.current?.(path)
    browserPickerResolution.current = null
    setBrowserPickerOpen(false)
  }

  const handleAddClick = async () => {
    try {
      const selected = await localApi.pickFolder(openBrowserPicker)

      if (!selected) {
        return
      }

      await submitProject(selected)
    } catch (error: unknown) {
      const message = extractErrorMessage(error)
      toast.error(message)
    }
  }

  return (
    <>
      <Button
        disabled={!isServerReady || isAdding}
        onClick={handleAddClick}
        size="sm"
        title={isServerReady ? undefined : 'Connecting to server...'}
        variant="outline"
      >
        <FolderPlus className="size-3.5" />
        {addProjectLabel(isServerReady, isAdding, true)}
      </Button>
      <BrowserDirectoryPicker
        onCancel={() => resolveBrowserPicker(null)}
        onSelect={resolveBrowserPicker}
        open={browserPickerOpen}
      />
    </>
  )
}

export { AddProjectForm }
