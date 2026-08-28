import { Schema } from 'effect'

const NonEmpty = Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
const BoundedId = NonEmpty.check(Schema.isMaxLength(128))
const TimeoutMs = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(60_000)
)

export const BrowserControlOperation = Schema.Literals([
  'status',
  'open',
  'navigate',
  'resize',
  'snapshot',
  'click',
  'type',
  'press',
  'scroll',
  'evaluate',
  'waitFor',
  'recordingStart',
  'recordingStop',
])
export type BrowserControlOperation = typeof BrowserControlOperation.Type

const OptionalTimeoutMs = Schema.optional(TimeoutMs)
const TabTarget = { tabId: Schema.optional(BoundedId) }

export const BrowserControlOpenInput = Schema.Struct({
  ...TabTarget,
  url: Schema.optional(
    Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1))
  ),
  open: Schema.optional(Schema.Boolean),
  reuseExistingTab: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (input) =>
      !(input.tabId !== undefined && input.reuseExistingTab === false) ||
      'tabId cannot be combined with reuseExistingTab=false.'
  )
)
export type BrowserControlOpenInput = typeof BrowserControlOpenInput.Type

export const BrowserControlNavigateInput = Schema.Struct({
  ...TabTarget,
  url: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  readiness: Schema.optional(
    Schema.Literals(['load', 'domContentLoaded', 'none'])
  ),
  timeoutMs: OptionalTimeoutMs,
})
export type BrowserControlNavigateInput =
  typeof BrowserControlNavigateInput.Type

const BrowserControlViewportPresetId = Schema.Literals([
  'iphone-se',
  'iphone-xr',
  'iphone-12-pro',
  'iphone-14-pro-max',
  'pixel-7',
  'samsung-galaxy-s8-plus',
  'samsung-galaxy-s20-ultra',
  'ipad-mini',
  'ipad-air',
  'ipad-pro',
  'surface-pro-7',
  'surface-duo',
  'galaxy-z-fold-5',
  'asus-zenbook-fold',
  'samsung-galaxy-a51-71',
  'nest-hub',
  'nest-hub-max',
])

const ViewportDimension = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(240),
  Schema.isLessThanOrEqualTo(3840)
)

export const BrowserControlResizeInput = Schema.Struct({
  ...TabTarget,
  mode: Schema.Literals(['fill', 'freeform', 'preset']),
  preset: Schema.optional(BrowserControlViewportPresetId),
  width: Schema.optional(ViewportDimension),
  height: Schema.optional(ViewportDimension),
  orientation: Schema.optional(Schema.Literals(['portrait', 'landscape'])),
  timeoutMs: OptionalTimeoutMs,
}).check(
  Schema.makeFilter((input) => {
    const hasDimensions =
      input.width !== undefined && input.height !== undefined
    if ((input.width === undefined) !== (input.height === undefined)) {
      return 'Custom dimensions require both width and height.'
    }
    if (input.mode === 'fill') {
      return !hasDimensions &&
        input.preset === undefined &&
        input.orientation === undefined
        ? true
        : 'Fill mode does not accept a preset, dimensions, or orientation.'
    }
    if (input.mode === 'freeform') {
      const { width, height } = input
      if (
        width === undefined ||
        height === undefined ||
        input.preset !== undefined ||
        input.orientation !== undefined
      ) {
        return 'Freeform mode requires width and height only.'
      }
      return width * height <= 3840 * 2160 || 'Viewport area is too large.'
    }
    return input.preset !== undefined && !hasDimensions
      ? true
      : 'Preset mode requires a preset and does not accept dimensions.'
  })
)
export type BrowserControlResizeInput = typeof BrowserControlResizeInput.Type

const BrowserControlViewportSetting = Schema.Union([
  Schema.TaggedStruct('fill', {}),
  Schema.TaggedStruct('freeform', {
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.TaggedStruct('preset', {
    presetId: BrowserControlViewportPresetId,
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
])

export const BrowserControlStatus = Schema.Struct({
  available: Schema.Boolean,
  visible: Schema.Boolean,
  tabId: Schema.NullOr(BoundedId),
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  loading: Schema.Boolean,
  viewportSetting: Schema.optional(BrowserControlViewportSetting),
  viewport: Schema.optional(
    Schema.Struct({
      width: Schema.Int.check(Schema.isGreaterThan(0)),
      height: Schema.Int.check(Schema.isGreaterThan(0)),
    })
  ),
})
export type BrowserControlStatus = typeof BrowserControlStatus.Type

export const BrowserControlResizeResult = Schema.Struct({
  tabId: BoundedId,
  setting: BrowserControlViewportSetting,
  viewport: Schema.Struct({
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
})
export type BrowserControlResizeResult = typeof BrowserControlResizeResult.Type

export const BrowserControlRecordingStatus = Schema.Struct({
  tabId: BoundedId,
  recording: Schema.Boolean,
  startedAt: Schema.NullOr(Schema.String),
})
export type BrowserControlRecordingStatus =
  typeof BrowserControlRecordingStatus.Type

export const BrowserControlRecordingArtifact = Schema.Struct({
  id: Schema.String,
  tabId: BoundedId,
  path: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.String,
})
export type BrowserControlRecordingArtifact =
  typeof BrowserControlRecordingArtifact.Type

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
