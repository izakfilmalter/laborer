import { Schema } from 'effect'

export class StoreError extends Schema.TaggedError<StoreError>()('StoreError', {
  operation: Schema.String,
  reason: Schema.String,
}) {}

export class HandlerFailure extends Schema.TaggedError<HandlerFailure>()(
  'HandlerFailure',
  {
    category: Schema.Literals([
      'spawn',
      'protocol',
      'exit',
      'signal',
      'timeout',
    ]),
    noticeStyle: Schema.optional(Schema.Literal('generic')),
    safeDetail: Schema.NullOr(Schema.String),
  }
) {}
