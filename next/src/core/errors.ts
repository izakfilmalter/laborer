import { Schema } from 'effect'

export class StoreError extends Schema.TaggedErrorClass<StoreError>()(
  'StoreError',
  {
    operation: Schema.String,
    reason: Schema.String,
  }
) {}

export class HandlerFailure extends Schema.TaggedErrorClass<HandlerFailure>()(
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
