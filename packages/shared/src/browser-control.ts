import { Schema } from 'effect'

const NonEmpty = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const BoundedId = NonEmpty.check(Schema.isMaxLength(128))
const TimeoutMs = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(60_000)
)

export const BrowserControlOperation = Schema.Literals([
  'status',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'evaluate',
  'waitFor',
])
export type BrowserControlOperation = typeof BrowserControlOperation.Type

export const BrowserControlHost = Schema.Struct({
  clientId: BoundedId,
  workspaceId: NonEmpty,
})
export type BrowserControlHost = typeof BrowserControlHost.Type

export const BrowserControlRequest = Schema.Struct({
  requestId: BoundedId,
  controllerId: BoundedId,
  workspaceId: NonEmpty,
  tabId: Schema.optional(BoundedId),
  operation: BrowserControlOperation,
  input: Schema.Unknown,
  timeoutMs: TimeoutMs,
})
export type BrowserControlRequest = typeof BrowserControlRequest.Type

export const BrowserControlEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('connected'), connectionId: BoundedId }),
  Schema.Struct({
    type: Schema.Literal('request'),
    connectionId: BoundedId,
    request: BrowserControlRequest,
  }),
])
export type BrowserControlEvent = typeof BrowserControlEvent.Type

export const BrowserControlResponse = Schema.Struct({
  clientId: BoundedId,
  connectionId: BoundedId,
  requestId: BoundedId,
  status: Schema.Literals(['result', 'failed', 'cancelled']),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({ tag: NonEmpty, message: Schema.String })
  ),
})
export type BrowserControlResponse = typeof BrowserControlResponse.Type

export class BrowserControlError extends Schema.TaggedError<BrowserControlError>()(
  'BrowserControlError',
  {
    code: Schema.Literals([
      'NO_HOST',
      'NOT_OWNER',
      'TIMEOUT',
      'DISCONNECTED',
      'CANCELLED',
      'FAILED',
    ]),
    message: Schema.String,
  }
) {}

export const BrowserAnnotationRect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
})
export const BrowserAnnotation = Schema.Struct({
  id: BoundedId,
  comment: Schema.String.check(Schema.isMaxLength(10_000)),
  createdAt: Schema.String,
  pageTitle: Schema.NullOr(Schema.String),
  pageUrl: Schema.String.check(Schema.isMaxLength(2048)),
  elements: Schema.Array(
    Schema.Struct({
      id: BoundedId,
      rect: BrowserAnnotationRect,
      element: Schema.Struct({
        componentName: Schema.NullOr(Schema.String),
        htmlPreview: Schema.String,
        pageTitle: Schema.NullOr(Schema.String),
        pageUrl: Schema.String,
        pickedAt: Schema.String,
        selector: Schema.NullOr(Schema.String),
        source: Schema.Unknown,
        stack: Schema.Array(Schema.Unknown),
        styles: Schema.String,
        tagName: Schema.String,
      }),
    })
  ),
  regions: Schema.Array(
    Schema.Struct({ id: BoundedId, rect: BrowserAnnotationRect })
  ),
  strokes: Schema.Array(Schema.Unknown),
  styleChanges: Schema.Array(Schema.Unknown),
  screenshot: Schema.NullOr(
    Schema.Struct({
      cropRect: BrowserAnnotationRect,
      dataUrl: Schema.String.check(Schema.isMaxLength(20_000_000)),
      width: Schema.Int,
      height: Schema.Int,
    })
  ),
})
export type BrowserAnnotation = typeof BrowserAnnotation.Type

export const BrowserContextItem = Schema.Struct({
  id: BoundedId,
  workspaceId: NonEmpty,
  annotation: Schema.Struct({
    ...BrowserAnnotation.fields,
    screenshot: Schema.NullOr(
      Schema.Struct({
        artifactPath: Schema.String,
        mimeType: Schema.Literal('image/png'),
        width: Schema.Int,
        height: Schema.Int,
      })
    ),
  }),
  state: Schema.Literals(['pending', 'consumed']),
  deliveredAt: Schema.String,
  consumedAt: Schema.NullOr(Schema.String),
})
export type BrowserContextItem = typeof BrowserContextItem.Type

export class BrowserContextError extends Schema.TaggedError<BrowserContextError>()(
  'BrowserContextError',
  {
    code: Schema.Literals(['INVALID_ARTIFACT', 'NOT_FOUND', 'IO_FAILED']),
    message: Schema.String,
  }
) {}
