import { Schema } from "effect";

export class SlackConfigValidationError extends Schema.TaggedErrorClass<SlackConfigValidationError>()(
  "SlackConfigValidationError",
  {
    variable: Schema.String,
    reason: Schema.String,
  }
) {}

export class LaborerConfigError extends Schema.TaggedErrorClass<LaborerConfigError>()(
  "LaborerConfigError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export class SlackStartupError extends Schema.TaggedErrorClass<SlackStartupError>()(
  "SlackStartupError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}
