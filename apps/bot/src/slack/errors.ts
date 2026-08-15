import { Schema } from 'effect'

export class SlackConfigValidationError extends Schema.TaggedError<SlackConfigValidationError>()(
  'SlackConfigValidationError',
  {
    variable: Schema.String,
    reason: Schema.String,
  }
) {}

export class LaborerConfigError extends Schema.TaggedError<LaborerConfigError>()(
  'LaborerConfigError',
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export class SlackStartupError extends Schema.TaggedError<SlackStartupError>()(
  'SlackStartupError',
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}
