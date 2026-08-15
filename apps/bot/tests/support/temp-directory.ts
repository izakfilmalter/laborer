import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Effect, Exit, Schema } from 'effect'

class TempDirectoryError extends Schema.TaggedError<TempDirectoryError>()(
  'TempDirectoryError',
  {
    operation: Schema.Literals(['create', 'canonicalize']),
  }
) {}

export const makeTempDirectoryScoped = Effect.fnUntraced(function* (
  prefix: string,
  options?: {
    readonly canonicalize?: (directory: string) => Promise<string>
  }
) {
  const cleanup = (directory: string) =>
    Effect.tryPromise({
      try: () => rm(directory, { force: true, recursive: true }),
      catch: () => undefined,
    }).pipe(Effect.ignore)
  return yield* Effect.acquireRelease(
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), prefix)),
        catch: () => TempDirectoryError.make({ operation: 'create' }),
      }),
      (rawDirectory) =>
        Effect.tryPromise({
          try: () => (options?.canonicalize ?? realpath)(rawDirectory),
          catch: () => TempDirectoryError.make({ operation: 'canonicalize' }),
        }),
      (rawDirectory, exit) =>
        Exit.isFailure(exit) ? cleanup(rawDirectory) : Effect.void
    ),
    cleanup
  )
})
