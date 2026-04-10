import { Schema } from 'effect'

import { TrimmedNonEmptyString } from './base'

export const ShellOpenInEditorInput = Schema.Struct({
  path: TrimmedNonEmptyString,
})
export type ShellOpenInEditorInput = typeof ShellOpenInEditorInput.Type

export class ShellOpenInEditorError extends Schema.TaggedError<ShellOpenInEditorError>()(
  'ShellOpenInEditorError',
  {
    path: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  }
) {}
