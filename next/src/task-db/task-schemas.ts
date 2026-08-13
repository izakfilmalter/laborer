import { Schema } from 'effect'

export const ACTION_TITLE_MAX_LENGTH = 100

export const ActionTitle = Schema.String.check(
  Schema.isPattern(/\S/),
  Schema.isMaxLength(ACTION_TITLE_MAX_LENGTH)
).annotate({
  description: 'A short, nonblank title for the Action Execution.',
})
