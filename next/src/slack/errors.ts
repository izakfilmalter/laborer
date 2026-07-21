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

export class SlackBoundaryError extends Schema.TaggedErrorClass<SlackBoundaryError>()(
  "SlackBoundaryError",
  {
    boundary: Schema.String,
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

export class SocketModeAdapterError extends Schema.TaggedErrorClass<SocketModeAdapterError>()(
  "SocketModeAdapterError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export class RunnerLockError extends Schema.TaggedErrorClass<RunnerLockError>()(
  "RunnerLockError",
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}
