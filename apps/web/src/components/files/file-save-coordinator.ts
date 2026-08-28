// biome-ignore-all lint/complexity/noVoid: fire-and-forget persistence is the point — the coordinator's own revision counter tracks completion, ported from t3code.

/**
 * Ported from t3code's `fileSaveCoordinator.ts`. Laborer's persist callback
 * reports its outcome with a plain tagged object instead of t3's
 * AtomCommandResult; the debounce/retry behavior is unchanged.
 */

/** How a persist attempt ended. Failures leave the file marked pending. */
export type FileSaveOutcome =
  | { readonly _tag: 'Success' }
  | { readonly _tag: 'Failure' }

export interface FileSaveCoordinatorOptions {
  readonly debounceMs: number
  readonly onConfirmed: (contents: string) => void
  readonly onPendingChange: (pending: boolean) => void
  readonly persist: (contents: string) => Promise<FileSaveOutcome>
}

export class FileSaveCoordinator {
  private timer: ReturnType<typeof setTimeout> | null = null
  private latestContents = ''
  private latestRevision = 0
  private lastChangeAt = 0
  private saving = false
  private disposed = false
  private readonly options: FileSaveCoordinatorOptions

  constructor(options: FileSaveCoordinatorOptions) {
    this.options = options
  }

  change(contents: string): void {
    this.latestContents = contents
    this.latestRevision += 1
    this.lastChangeAt = Date.now()
    this.options.onPendingChange(true)
    this.schedule(this.options.debounceMs)
  }

  dispose(): void {
    this.disposed = true
    this.clearTimer()
    if (this.latestRevision > 0) {
      void this.persistLatest()
    }
  }

  private schedule(delay: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.persistLatest()
    }, delay)
  }

  private clearTimer(): void {
    if (this.timer === null) {
      return
    }
    clearTimeout(this.timer)
    this.timer = null
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === 0) {
      return
    }

    this.saving = true
    const contents = this.latestContents
    const revision = this.latestRevision
    const result = await this.options.persist(contents)
    const succeeded = result._tag === 'Success'
    if (succeeded) {
      this.options.onConfirmed(contents)
    }

    this.saving = false
    if (revision === this.latestRevision) {
      if (succeeded) {
        this.options.onPendingChange(false)
      }
      return
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt)
    )
    if (this.disposed) {
      void this.persistLatest()
    } else {
      this.schedule(remainingDebounce)
    }
  }
}
