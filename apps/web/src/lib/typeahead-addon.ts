/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *
 *  Adapted for laborer from VS Code's terminalTypeAheadAddon.ts.
 *  Original: src/vs/workbench/contrib/terminalContrib/typeAhead/browser/terminalTypeAheadAddon.ts
 *--------------------------------------------------------------------------------------------*/

import type {
  IBuffer,
  IBufferCell,
  IDisposable,
  ITerminalAddon,
  Terminal,
} from '@xterm/xterm'

// ---------------------------------------------------------------------------
// Inline replacements for VS Code framework dependencies
// ---------------------------------------------------------------------------

/**
 * Minimal Event interface matching VS Code's `Event<T>`.
 */
type Event<T> = (listener: (e: T) => void, thisArgs?: unknown) => IDisposable

/**
 * Minimal Emitter matching VS Code's Emitter API surface.
 */
export class Emitter<T> {
  private readonly _listeners: Set<(e: T) => void> = new Set()
  private _disposed = false

  readonly event: Event<T> = (listener: (e: T) => void) => {
    if (this._disposed) {
      return {
        dispose: () => {
          // no-op: emitter already disposed
        },
      }
    }
    this._listeners.add(listener)
    return {
      dispose: () => {
        this._listeners.delete(listener)
      },
    }
  }

  fire(event: T): void {
    if (this._disposed) {
      return
    }
    for (const listener of this._listeners) {
      listener(event)
    }
  }

  dispose(): void {
    this._disposed = true
    this._listeners.clear()
  }
}

/**
 * Minimal Disposable base class matching VS Code's Disposable.
 */
class Disposable implements IDisposable {
  private readonly _disposables: IDisposable[] = []

  protected _register<T extends IDisposable>(disposable: T): T {
    this._disposables.push(disposable)
    return disposable
  }

  dispose(): void {
    for (const d of this._disposables) {
      d.dispose()
    }
    this._disposables.length = 0
  }
}

function toDisposable(fn: () => void): IDisposable {
  return { dispose: fn }
}

// ---------------------------------------------------------------------------
// Inline utility replacements
// ---------------------------------------------------------------------------

function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&')
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

type SingleOrMany<T> = T | T[]

// ---------------------------------------------------------------------------
// XtermAttributes / IXtermCore — inline type defs matching xterm 6.x internals
// ---------------------------------------------------------------------------

type XtermAttributes = Omit<
  IBufferCell,
  'getWidth' | 'getChars' | 'getCode'
> & {
  clone?(): XtermAttributes
}

interface IXtermCore {
  readonly _inputHandler: {
    readonly _curAttrData: XtermAttributes
  }
}

// ---------------------------------------------------------------------------
// Process manager interface (replaces ITerminalProcessManager)
// ---------------------------------------------------------------------------

/**
 * Event object for intercepting PTY data before it reaches xterm.
 * The `data` property is mutable — listeners can modify it.
 */
export interface IBeforeProcessDataEvent {
  data: string
}

/**
 * Minimal process manager interface the addon needs.
 * Replaces VS Code's full ITerminalProcessManager.
 */
export interface ITypeAheadProcessManager {
  readonly onBeforeProcessData: Event<IBeforeProcessDataEvent>
}

// ---------------------------------------------------------------------------
// Configuration interface (replaces IConfigurationService)
// ---------------------------------------------------------------------------

export interface ITypeAheadConfig {
  readonly excludePrograms: readonly string[]
  readonly latencyThreshold: number
  readonly style: 'bold' | 'dim' | 'italic' | 'underlined' | 'inverted' | string
}

export const DEFAULT_CONFIG: ITypeAheadConfig = {
  excludePrograms: ['vim', 'vi', 'nano', 'tmux'],
  latencyThreshold: 30,
  style: 'dim',
}

// ---------------------------------------------------------------------------
// VT constants
// ---------------------------------------------------------------------------

const VT = {
  Csi: '\x1b[',
  DeleteChar: '\x1b[X',
  DeleteRestOfLine: '\x1b[K',
  Esc: '\x1b',
  HideCursor: '\x1b[?25l',
  ShowCursor: '\x1b[?25h',
} as const

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence matching requires control characters
const CSI_STYLE_RE = /^\x1b\[[0-9;]*m/
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence matching requires control characters
const CSI_MOVE_RE = /^\x1b\[?([0-9]*)(;[35])?O?([DC])/
const NOT_WORD_RE = /[^a-z0-9]/i
const HEX_PREFIX_RE = /^#/

const StatsConstants = {
  StatsBufferSize: 24,
  StatsMinAccuracyToTurnOn: 0.3,
  StatsMinSamplesToTurnOn: 5,
  StatsToggleOffThreshold: 0.5,
} as const

/**
 * Codes that should be omitted from sending to the prediction engine and instead omitted directly:
 * - Hide cursor (DECTCEM): We wrap the local echo sequence in hide and show
 *   CSI ? 2 5 l
 * - Show cursor (DECTCEM): We wrap the local echo sequence in hide and show
 *   CSI ? 2 5 h
 * - Device Status Report (DSR): These sequence fire report events from xterm which could cause
 *   double reporting and potentially a stack overflow (#119472)
 *   CSI Ps n
 *   CSI ? Ps n
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence matching requires control characters
const PREDICTION_OMIT_RE = /^(\x1b\[(\??25[hl]|\??[0-9;]+n))+/

const core = (terminal: Terminal): IXtermCore => {
  return (terminal as unknown as { _core: IXtermCore })._core
}

const flushOutput = (_terminal: Terminal) => {
  // Flushing output is not possible anymore without async
}

const CursorMoveDirection = {
  Back: 'D',
  Forwards: 'C',
} as const
type CursorMoveDirection =
  (typeof CursorMoveDirection)[keyof typeof CursorMoveDirection]

// ---------------------------------------------------------------------------
// Coordinate / Cursor
// ---------------------------------------------------------------------------

interface ICoordinate {
  readonly baseY: number
  readonly x: number
  readonly y: number
}

class Cursor implements ICoordinate {
  readonly rows: number
  readonly cols: number
  private readonly _buffer: IBuffer
  private _x = 0
  private _y = 1
  private _baseY = 1

  get x() {
    return this._x
  }

  get y() {
    return this._y
  }

  get baseY() {
    return this._baseY
  }

  get coordinate(): ICoordinate {
    return { baseY: this._baseY, x: this._x, y: this._y }
  }

  constructor(rows: number, cols: number, buffer: IBuffer) {
    this.rows = rows
    this.cols = cols
    this._buffer = buffer
    this._x = buffer.cursorX
    this._y = buffer.cursorY
    this._baseY = buffer.baseY
  }

  getLine() {
    return this._buffer.getLine(this._y + this._baseY)
  }

  getCell(loadInto?: IBufferCell) {
    return this.getLine()?.getCell(this._x, loadInto)
  }

  moveTo(coordinate: ICoordinate) {
    this._x = coordinate.x
    this._y = coordinate.y + coordinate.baseY - this._baseY
    return this.moveInstruction()
  }

  clone() {
    const c = new Cursor(this.rows, this.cols, this._buffer)
    c.moveTo(this)
    return c
  }

  move(x: number, y: number) {
    this._x = x
    this._y = y
    return this.moveInstruction()
  }

  shift(x = 0, y = 0) {
    this._x += x
    this._y += y
    return this.moveInstruction()
  }

  moveInstruction() {
    if (this._y >= this.rows) {
      this._baseY += this._y - (this.rows - 1)
      this._y = this.rows - 1
    } else if (this._y < 0) {
      this._baseY -= this._y
      this._y = 0
    }

    return `${VT.Csi}${this._y + 1};${this._x + 1}H`
  }
}

const moveToWordBoundary = (_b: IBuffer, cursor: Cursor, direction: -1 | 1) => {
  let ateLeadingWhitespace = false
  if (direction < 0) {
    cursor.shift(-1)
  }

  let cell: IBufferCell | undefined
  while (cursor.x >= 0) {
    cell = cursor.getCell(cell)
    if (!cell?.getCode()) {
      return
    }

    const chars = cell.getChars()
    if (NOT_WORD_RE.test(chars)) {
      if (ateLeadingWhitespace) {
        break
      }
    } else {
      ateLeadingWhitespace = true
    }

    cursor.shift(direction)
  }

  if (direction < 0) {
    cursor.shift(1) // place cursor after whitespace starting the word
  }
}

// ---------------------------------------------------------------------------
// Match result
// ---------------------------------------------------------------------------

const MatchResult = {
  /** matched successfully */
  Success: 0,
  /** failed to match */
  Failure: 1,
  /** buffer data — might match when more data comes in */
  Buffer: 2,
} as const
type MatchResult = (typeof MatchResult)[keyof typeof MatchResult]

// ---------------------------------------------------------------------------
// Prediction interface
// ---------------------------------------------------------------------------

export interface IPrediction {
  readonly affectsStyle?: boolean
  apply(buffer: IBuffer, cursor: Cursor): string
  readonly clearAfterTimeout?: boolean
  matches(input: StringReader, lookBehind?: IPrediction): MatchResult
  rollback(cursor: Cursor): string
  rollForwards(cursor: Cursor, withInput: string): string
}

// ---------------------------------------------------------------------------
// StringReader
// ---------------------------------------------------------------------------

class StringReader {
  index = 0
  private readonly _input: string

  get remaining() {
    return this._input.length - this.index
  }

  get eof() {
    return this.index === this._input.length
  }

  get rest() {
    return this._input.slice(this.index)
  }

  constructor(input: string) {
    this._input = input
  }

  eatChar(char: string) {
    if (this._input[this.index] !== char) {
      return undefined
    }
    this.index++
    return char
  }

  eatStr(substr: string) {
    if (this._input.slice(this.index, this.index + substr.length) !== substr) {
      return undefined
    }
    this.index += substr.length
    return substr
  }

  eatGradually(substr: string): MatchResult {
    const prevIndex = this.index
    for (let i = 0; i < substr.length; i++) {
      if (i > 0 && this.eof) {
        return MatchResult.Buffer
      }
      if (!this.eatChar(substr[i] ?? '')) {
        this.index = prevIndex
        return MatchResult.Failure
      }
    }
    return MatchResult.Success
  }

  eatRe(re: RegExp) {
    const match = re.exec(this._input.slice(this.index))
    if (!match) {
      return undefined
    }
    this.index += match[0].length
    return match
  }

  eatCharCode(min = 0, max = min + 1) {
    const code = this._input.charCodeAt(this.index)
    if (code < min || code >= max) {
      return undefined
    }
    this.index++
    return code
  }
}

// ---------------------------------------------------------------------------
// Prediction classes
// ---------------------------------------------------------------------------

/**
 * Prediction which never tests true. Will always discard predictions made after it.
 */
class HardBoundary implements IPrediction {
  readonly clearAfterTimeout = false

  apply() {
    return ''
  }

  rollback() {
    return ''
  }

  rollForwards() {
    return ''
  }

  matches() {
    return MatchResult.Failure
  }
}

/**
 * Wraps another prediction. Does not apply the prediction, but will pass
 * through its `matches` request.
 */
class TentativeBoundary implements IPrediction {
  readonly inner: IPrediction
  private _appliedCursor?: Cursor

  constructor(inner: IPrediction) {
    this.inner = inner
  }

  apply(buffer: IBuffer, cursor: Cursor) {
    this._appliedCursor = cursor.clone()
    this.inner.apply(buffer, this._appliedCursor)
    return ''
  }

  rollback(cursor: Cursor) {
    this.inner.rollback(cursor.clone())
    return ''
  }

  rollForwards(cursor: Cursor, withInput: string) {
    if (this._appliedCursor) {
      cursor.moveTo(this._appliedCursor)
    }
    return withInput
  }

  matches(input: StringReader) {
    return this.inner.matches(input)
  }
}

const isTenativeCharacterPrediction = (
  p: unknown
): p is TentativeBoundary & { inner: CharacterPrediction } =>
  p instanceof TentativeBoundary && p.inner instanceof CharacterPrediction

/**
 * Prediction for a single alphanumeric character.
 */
class CharacterPrediction implements IPrediction {
  readonly affectsStyle = true
  private readonly _style: TypeAheadStyle
  private readonly _char: string

  appliedAt?: {
    pos: ICoordinate
    oldAttributes: string
    oldChar: string
  }

  constructor(style: TypeAheadStyle, char: string) {
    this._style = style
    this._char = char
  }

  apply(_: IBuffer, cursor: Cursor) {
    const cell = cursor.getCell()
    this.appliedAt = cell
      ? {
          pos: cursor.coordinate,
          oldAttributes: attributesToSeq(cell),
          oldChar: cell.getChars(),
        }
      : { pos: cursor.coordinate, oldAttributes: '', oldChar: '' }

    cursor.shift(1)

    return this._style.apply + this._char + this._style.undo
  }

  rollback(cursor: Cursor) {
    if (!this.appliedAt) {
      return '' // not applied
    }

    const { oldAttributes, oldChar, pos } = this.appliedAt
    const r =
      cursor.moveTo(pos) +
      (oldChar
        ? `${oldAttributes}${oldChar}${cursor.moveTo(pos)}`
        : VT.DeleteChar)
    return r
  }

  rollForwards(cursor: Cursor, input: string) {
    if (!this.appliedAt) {
      return '' // not applied
    }

    return cursor.clone().moveTo(this.appliedAt.pos) + input
  }

  matches(input: StringReader, lookBehind?: IPrediction) {
    const startIndex = input.index

    // remove any styling CSI before checking the char
    while (input.eatRe(CSI_STYLE_RE)) {
      // consume all style sequences
    }

    if (input.eof) {
      return MatchResult.Buffer
    }

    if (input.eatChar(this._char)) {
      return MatchResult.Success
    }

    if (lookBehind instanceof CharacterPrediction) {
      // see #112842
      const sillyZshOutcome = input.eatGradually(
        `\b${lookBehind._char}${this._char}`
      )
      if (sillyZshOutcome !== MatchResult.Failure) {
        return sillyZshOutcome
      }
    }

    input.index = startIndex
    return MatchResult.Failure
  }
}

class BackspacePrediction implements IPrediction {
  private readonly _terminal: Terminal

  protected _appliedAt?: {
    pos: ICoordinate
    oldAttributes: string
    oldChar: string
    isLastChar: boolean
  }

  constructor(terminal: Terminal) {
    this._terminal = terminal
  }

  apply(_: IBuffer, cursor: Cursor) {
    // at eol if everything to the right is whitespace
    const isLastChar = !cursor
      .getLine()
      ?.translateToString(undefined, cursor.x)
      .trim()
    const pos = cursor.coordinate
    const move = cursor.shift(-1)
    const cell = cursor.getCell()
    this._appliedAt = cell
      ? {
          isLastChar,
          pos,
          oldAttributes: attributesToSeq(cell),
          oldChar: cell.getChars(),
        }
      : { isLastChar, pos, oldAttributes: '', oldChar: '' }

    return move + VT.DeleteChar
  }

  rollback(cursor: Cursor) {
    if (!this._appliedAt) {
      return '' // not applied
    }

    const { oldAttributes, oldChar, pos } = this._appliedAt
    if (!oldChar) {
      return cursor.moveTo(pos) + VT.DeleteChar
    }

    return (
      oldAttributes +
      oldChar +
      cursor.moveTo(pos) +
      attributesToSeq(core(this._terminal)._inputHandler._curAttrData)
    )
  }

  rollForwards() {
    return ''
  }

  matches(input: StringReader) {
    if (this._appliedAt?.isLastChar) {
      const r1 = input.eatGradually(`\b${VT.Csi}K`)
      if (r1 !== MatchResult.Failure) {
        return r1
      }

      const r2 = input.eatGradually('\b \b')
      if (r2 !== MatchResult.Failure) {
        return r2
      }
    }

    return MatchResult.Failure
  }
}

class NewlinePrediction implements IPrediction {
  protected _prevPosition?: ICoordinate

  apply(_: IBuffer, cursor: Cursor) {
    this._prevPosition = cursor.coordinate
    cursor.move(0, cursor.y + 1)
    return '\r\n'
  }

  rollback(cursor: Cursor) {
    return this._prevPosition ? cursor.moveTo(this._prevPosition) : ''
  }

  rollForwards() {
    return '' // does not need to rewrite
  }

  matches(input: StringReader) {
    return input.eatGradually('\r\n')
  }
}

/**
 * Prediction when the cursor reaches the end of the line. Similar to newline
 * prediction, but shells handle it slightly differently.
 */
class LinewrapPrediction extends NewlinePrediction implements IPrediction {
  override apply(_: IBuffer, cursor: Cursor) {
    this._prevPosition = cursor.coordinate
    cursor.move(0, cursor.y + 1)
    return ' \r'
  }

  override matches(input: StringReader) {
    // bash and zshell add a space which wraps in the terminal, then a CR
    const r = input.eatGradually(' \r')
    if (r !== MatchResult.Failure) {
      // zshell additionally adds a clear line after wrapping to be safe — eat it
      const r2 = input.eatGradually(VT.DeleteRestOfLine)
      return r2 === MatchResult.Buffer ? MatchResult.Buffer : r
    }

    return input.eatGradually('\r\n')
  }
}

class CursorMovePrediction implements IPrediction {
  private readonly _direction: CursorMoveDirection
  private readonly _moveByWords: boolean
  private readonly _amount: number

  private _applied?: {
    rollForward: string
    prevPosition: number
    prevAttrs: string
    amount: number
  }

  constructor(
    direction: CursorMoveDirection,
    moveByWords: boolean,
    amount: number
  ) {
    this._direction = direction
    this._moveByWords = moveByWords
    this._amount = amount
  }

  apply(buffer: IBuffer, cursor: Cursor) {
    const prevPosition = cursor.x
    const currentCell = cursor.getCell()
    const prevAttrs = currentCell ? attributesToSeq(currentCell) : ''

    const amount = this._amount
    const direction = this._direction
    const moveByWords = this._moveByWords
    const delta = direction === CursorMoveDirection.Back ? -1 : 1

    const target = cursor.clone()
    if (moveByWords) {
      for (let i = 0; i < amount; i++) {
        moveToWordBoundary(buffer, target, delta)
      }
    } else {
      target.shift(delta * amount)
    }

    this._applied = {
      amount: Math.abs(cursor.x - target.x),
      prevPosition,
      prevAttrs,
      rollForward: cursor.moveTo(target),
    }

    return this._applied.rollForward
  }

  rollback(cursor: Cursor) {
    if (!this._applied) {
      return ''
    }

    return (
      cursor.move(this._applied.prevPosition, cursor.y) +
      this._applied.prevAttrs
    )
  }

  rollForwards() {
    return '' // does not need to rewrite
  }

  matches(input: StringReader) {
    if (!this._applied) {
      return MatchResult.Failure
    }

    const direction = this._direction
    const { amount, rollForward } = this._applied

    // arg can be omitted to move one character
    if (input.eatStr(`${VT.Csi}${direction}`.repeat(amount))) {
      return MatchResult.Success
    }

    // \b is the equivalent to moving one character back
    if (
      direction === CursorMoveDirection.Back &&
      input.eatStr('\b'.repeat(amount))
    ) {
      return MatchResult.Success
    }

    // check if the cursor position is set absolutely
    if (rollForward) {
      const r = input.eatGradually(rollForward)
      if (r !== MatchResult.Failure) {
        return r
      }
    }

    // check for a relative move in the direction
    return input.eatGradually(`${VT.Csi}${amount}${direction}`)
  }
}

// ---------------------------------------------------------------------------
// PredictionStats
// ---------------------------------------------------------------------------

export class PredictionStats extends Disposable {
  private readonly _stats: [latency: number, correct: boolean][] = []
  private _index = 0
  private readonly _addedAtTime = new WeakMap<IPrediction, number>()
  private readonly _changeEmitter = this._register(new Emitter<void>())
  readonly onChange = this._changeEmitter.event

  get accuracy() {
    let correctCount = 0
    for (const [, correct] of this._stats) {
      if (correct) {
        correctCount++
      }
    }
    return correctCount / (this._stats.length || 1)
  }

  get sampleSize() {
    return this._stats.length
  }

  get latency() {
    const latencies = this._stats
      .filter(([, correct]) => correct)
      .map(([s]) => s)
      .sort()

    return {
      count: latencies.length,
      max: latencies.at(-1),
      median: latencies.at(Math.floor(latencies.length / 2)),
      min: latencies.at(0),
    }
  }

  get maxLatency() {
    let max = Number.NEGATIVE_INFINITY
    for (const [latency, correct] of this._stats) {
      if (correct) {
        max = Math.max(latency, max)
      }
    }
    return max
  }

  constructor(timeline: PredictionTimeline) {
    super()
    this._register(
      timeline.onPredictionAdded((p) => this._addedAtTime.set(p, Date.now()))
    )
    this._register(
      timeline.onPredictionSucceeded(this._pushStat.bind(this, true))
    )
    this._register(
      timeline.onPredictionFailed(this._pushStat.bind(this, false))
    )
  }

  private _pushStat(correct: boolean, prediction: IPrediction) {
    const started = this._addedAtTime.get(prediction)
    if (started === undefined) {
      return
    }
    this._stats[this._index] = [Date.now() - started, correct]
    this._index = (this._index + 1) % StatsConstants.StatsBufferSize
    this._changeEmitter.fire()
  }
}

// ---------------------------------------------------------------------------
// PredictionTimeline
// ---------------------------------------------------------------------------

export class PredictionTimeline extends Disposable {
  private _expected: { gen: number; p: IPrediction }[] = []
  private _currentGen = 0
  private _physicalCursor: Cursor | undefined
  private _tenativeCursor: Cursor | undefined
  private _inputBuffer: string | undefined
  private _showPredictions = false
  private _lookBehind: IPrediction | undefined

  private readonly _addedEmitter = this._register(new Emitter<IPrediction>())
  readonly onPredictionAdded = this._addedEmitter.event
  private readonly _failedEmitter = this._register(new Emitter<IPrediction>())
  readonly onPredictionFailed = this._failedEmitter.event
  private readonly _succeededEmitter = this._register(
    new Emitter<IPrediction>()
  )
  readonly onPredictionSucceeded = this._succeededEmitter.event

  readonly terminal: Terminal
  private readonly _style: TypeAheadStyle

  private get _currentGenerationPredictions() {
    const firstGen = this._expected[0]?.gen
    return this._expected
      .filter(({ gen }) => gen === firstGen)
      .map(({ p }) => p)
  }

  get isShowingPredictions() {
    return this._showPredictions
  }

  get length() {
    return this._expected.length
  }

  constructor(terminal: Terminal, style: TypeAheadStyle) {
    super()
    this.terminal = terminal
    this._style = style
  }

  setShowPredictions(show: boolean) {
    if (show === this._showPredictions) {
      return
    }

    this._showPredictions = show

    const buffer = this._getActiveBuffer()
    if (!buffer) {
      return
    }

    const toApply = this._currentGenerationPredictions
    if (show) {
      this.clearCursor()
      this._style.expectIncomingStyle(
        toApply.reduce((count, p) => (p.affectsStyle ? count + 1 : count), 0)
      )
      this.terminal.write(
        toApply
          .map((p) => p.apply(buffer, this.physicalCursor(buffer)))
          .join('')
      )
    } else {
      this.terminal.write(
        toApply
          .reverse()
          .map((p) => p.rollback(this.physicalCursor(buffer)))
          .join('')
      )
    }
  }

  undoAllPredictions() {
    const buffer = this._getActiveBuffer()
    if (this._showPredictions && buffer) {
      this.terminal.write(
        this._currentGenerationPredictions
          .reverse()
          .map((p) => p.rollback(this.physicalCursor(buffer)))
          .join('')
      )
    }
    this._expected = []
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported from VS Code — core reconciliation logic requires coordinated state tracking
  beforeServerInput(serverInput: string): string {
    const originalInput = serverInput
    let input = serverInput
    if (this._inputBuffer) {
      input = this._inputBuffer + input
      this._inputBuffer = undefined
    }

    if (!this._expected.length) {
      this._clearPredictionState()
      return input
    }

    const buffer = this._getActiveBuffer()
    if (!buffer) {
      this._clearPredictionState()
      return input
    }

    let output = ''

    const reader = new StringReader(input)
    const firstEntry = this._expected[0]
    if (!firstEntry) {
      this._clearPredictionState()
      return input
    }
    const startingGen = firstEntry.gen
    const emitPredictionOmitted = () => {
      const omit = reader.eatRe(PREDICTION_OMIT_RE)
      if (omit) {
        output += omit[0]
      }
    }

    ReadLoop: while (this._expected.length && reader.remaining > 0) {
      emitPredictionOmitted()

      const first = this._expected[0]
      if (!first) {
        break
      }
      const { p: prediction, gen } = first
      const cursor = this.physicalCursor(buffer)
      const beforeTestReaderIndex = reader.index
      switch (prediction.matches(reader, this._lookBehind)) {
        case MatchResult.Success: {
          const eaten = input.slice(beforeTestReaderIndex, reader.index)
          if (gen === startingGen) {
            output += prediction.rollForwards(cursor, eaten)
          } else {
            prediction.apply(buffer, this.physicalCursor(buffer))
            output += eaten
          }

          this._succeededEmitter.fire(prediction)
          this._lookBehind = prediction
          this._expected.shift()
          break
        }
        case MatchResult.Buffer:
          this._inputBuffer = input.slice(beforeTestReaderIndex)
          reader.index = input.length
          break ReadLoop
        case MatchResult.Failure: {
          const rollback = this._expected
            .filter((p) => p.gen === startingGen)
            .reverse()
          output += rollback
            .map(({ p }) => p.rollback(this.physicalCursor(buffer)))
            .join('')
          if (rollback.some((r) => r.p.affectsStyle)) {
            output += attributesToSeq(
              core(this.terminal)._inputHandler._curAttrData
            )
          }
          this._clearPredictionState()
          this._failedEmitter.fire(prediction)
          break ReadLoop
        }
        default:
          break ReadLoop
      }
    }

    emitPredictionOmitted()

    // Extra data should cause us to reset the cursor
    if (!reader.eof) {
      output += reader.rest
      this._clearPredictionState()
    }

    // If we passed a generation boundary, apply the current generation's predictions
    if (this._expected.length && startingGen !== this._expected[0]?.gen) {
      for (const { p, gen } of this._expected) {
        if (gen !== this._expected[0]?.gen) {
          break
        }
        if (p.affectsStyle) {
          this._style.expectIncomingStyle()
        }
        output += p.apply(buffer, this.physicalCursor(buffer))
      }
    }

    if (!this._showPredictions) {
      return originalInput
    }

    if (output.length === 0 || output === input) {
      return output
    }

    if (this._physicalCursor) {
      output += this._physicalCursor.moveInstruction()
    }

    // prevent cursor flickering while typing
    output = VT.HideCursor + output + VT.ShowCursor

    return output
  }

  private _clearPredictionState() {
    this._expected = []
    this.clearCursor()
    this._lookBehind = undefined
  }

  addPrediction(buffer: IBuffer, prediction: IPrediction) {
    this._expected.push({ gen: this._currentGen, p: prediction })
    this._addedEmitter.fire(prediction)

    if (this._currentGen !== this._expected[0]?.gen) {
      prediction.apply(buffer, this.tentativeCursor(buffer))
      return false
    }

    const text = prediction.apply(buffer, this.physicalCursor(buffer))
    this._tenativeCursor = undefined // next read will get or clone the physical cursor

    if (this._showPredictions && text) {
      if (prediction.affectsStyle) {
        this._style.expectIncomingStyle()
      }
      this.terminal.write(text)
    }

    return true
  }

  addBoundary(): void
  addBoundary(buffer: IBuffer, prediction: IPrediction): boolean
  addBoundary(buffer?: IBuffer, prediction?: IPrediction) {
    let applied = false
    if (buffer && prediction) {
      applied = this.addPrediction(buffer, new TentativeBoundary(prediction))
      prediction.apply(buffer, this.tentativeCursor(buffer))
    }
    this._currentGen++
    return applied
  }

  peekEnd(): IPrediction | undefined {
    return this._expected.at(-1)?.p
  }

  peekStart(): IPrediction | undefined {
    return this._expected[0]?.p
  }

  physicalCursor(buffer: IBuffer) {
    if (!this._physicalCursor) {
      if (this._showPredictions) {
        flushOutput(this.terminal)
      }
      this._physicalCursor = new Cursor(
        this.terminal.rows,
        this.terminal.cols,
        buffer
      )
    }
    return this._physicalCursor
  }

  tentativeCursor(buffer: IBuffer) {
    if (!this._tenativeCursor) {
      this._tenativeCursor = this.physicalCursor(buffer).clone()
    }
    return this._tenativeCursor
  }

  clearCursor() {
    this._physicalCursor = undefined
    this._tenativeCursor = undefined
  }

  private _getActiveBuffer() {
    const buffer = this.terminal.buffer.active
    return buffer.type === 'normal' ? buffer : undefined
  }
}

// ---------------------------------------------------------------------------
// Attribute helpers
// ---------------------------------------------------------------------------

const attributesToArgs = (cell: XtermAttributes) => {
  if (cell.isAttributeDefault()) {
    return [0]
  }

  const args: number[] = []
  if (cell.isBold()) {
    args.push(1)
  }
  if (cell.isDim()) {
    args.push(2)
  }
  if (cell.isItalic()) {
    args.push(3)
  }
  if (cell.isUnderline()) {
    args.push(4)
  }
  if (cell.isBlink()) {
    args.push(5)
  }
  if (cell.isInverse()) {
    args.push(7)
  }
  if (cell.isInvisible()) {
    args.push(8)
  }

  if (cell.isFgRGB()) {
    const fgColor = cell.getFgColor()
    // biome-ignore lint/suspicious/noBitwiseOperators: bit shifting required for RGB color extraction from packed integer
    args.push(38, 2, fgColor >>> 24, (fgColor >>> 16) & 0xff, fgColor & 0xff)
  }
  if (cell.isFgPalette()) {
    args.push(38, 5, cell.getFgColor())
  }
  if (cell.isFgDefault()) {
    args.push(39)
  }

  if (cell.isBgRGB()) {
    const bgColor = cell.getBgColor()
    // biome-ignore lint/suspicious/noBitwiseOperators: bit shifting required for RGB color extraction from packed integer
    args.push(48, 2, bgColor >>> 24, (bgColor >>> 16) & 0xff, bgColor & 0xff)
  }
  if (cell.isBgPalette()) {
    args.push(48, 5, cell.getBgColor())
  }
  if (cell.isBgDefault()) {
    args.push(49)
  }

  return args
}

const attributesToSeq = (cell: XtermAttributes) =>
  `${VT.Csi}${attributesToArgs(cell).join(';')}m`

const arrayHasPrefixAt = <T>(
  a: readonly T[],
  startIndex: number,
  b: readonly T[]
) => {
  if (a.length - startIndex > b.length) {
    return false
  }

  let idx = startIndex
  for (let bi = 0; bi < b.length; bi++, idx++) {
    if (b[idx] !== a[idx]) {
      return false
    }
  }

  return true
}

/**
 * @see https://github.com/xtermjs/xterm.js/blob/065eb13a9d3145bea687239680ec9696d9112b8e/src/common/InputHandler.ts#L2127
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported from VS Code — color width parsing requires nested loop with multiple break conditions
const getColorWidth = (params: SingleOrMany<number>[], pos: number) => {
  const accu = [0, 0, -1, 0, 0, 0]
  let cSpace = 0
  let advance = 0

  do {
    const v = params[pos + advance]
    if (v === undefined) {
      break
    }
    accu[advance + cSpace] = isNumber(v) ? v : (v[0] ?? 0)
    if (!isNumber(v)) {
      let i = 0
      do {
        if (accu[1] === 5) {
          cSpace = 1
        }
        accu[advance + i + 1 + cSpace] = v[i] ?? 0
      } while (++i < v.length && i + advance + 1 + cSpace < accu.length)
      break
    }
    // exit early if can decide color mode with semicolons
    if (
      (accu[1] === 5 && advance + cSpace >= 2) ||
      (accu[1] === 2 && advance + cSpace >= 5)
    ) {
      break
    }
    // offset colorSpace slot for semicolon mode
    if (accu[1]) {
      cSpace = 1
    }
  } while (++advance + pos < params.length && advance + cSpace < accu.length)

  return advance
}

// ---------------------------------------------------------------------------
// TypeAheadStyle
// ---------------------------------------------------------------------------

class TypeAheadStyle implements IDisposable {
  private static _compileArgs(args: readonly number[]) {
    return `${VT.Csi}${args.join(';')}m`
  }

  private _expectedIncomingStyles = 0
  private _applyArgs: readonly number[] = []
  private _originalUndoArgs: readonly number[] = []
  private _undoArgs: readonly number[] = []

  apply = ''
  undo = ''
  private _csiHandler: IDisposable | undefined
  private _stopTrackingTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _terminal: Terminal

  constructor(value: ITypeAheadConfig['style'], terminal: Terminal) {
    this._terminal = terminal
    this.onUpdate(value)
  }

  expectIncomingStyle(n = 1) {
    this._expectedIncomingStyles += n * 2
  }

  startTracking() {
    this._expectedIncomingStyles = 0
    this._onDidWriteSGR(
      attributesToArgs(core(this._terminal)._inputHandler._curAttrData)
    )
    this._csiHandler = this._terminal.parser.registerCsiHandler(
      { final: 'm' },
      (args) => {
        this._onDidWriteSGR(args)
        return false
      }
    )
  }

  debounceStopTracking() {
    if (this._stopTrackingTimer !== undefined) {
      clearTimeout(this._stopTrackingTimer)
    }
    this._stopTrackingTimer = setTimeout(() => {
      this._stopTrackingTimer = undefined
      this._stopTracking()
    }, 2000)
  }

  dispose() {
    if (this._stopTrackingTimer !== undefined) {
      clearTimeout(this._stopTrackingTimer)
    }
    this._stopTracking()
  }

  private _stopTracking() {
    this._csiHandler?.dispose()
    this._csiHandler = undefined
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported from VS Code — SGR state tracking requires nested switch/if logic
  private _onDidWriteSGR(args: SingleOrMany<number>[]) {
    const originalUndo = this._undoArgs
    for (let i = 0; i < args.length; ) {
      const px = args[i]
      if (px === undefined) {
        break
      }
      const p = isNumber(px) ? px : (px[0] ?? 0)

      if (this._expectedIncomingStyles) {
        if (arrayHasPrefixAt(args, i, this._undoArgs)) {
          this._expectedIncomingStyles--
          i += this._undoArgs.length
          continue
        }
        if (arrayHasPrefixAt(args, i, this._applyArgs)) {
          this._expectedIncomingStyles--
          i += this._applyArgs.length
          continue
        }
      }

      const width =
        p === 38 || p === 48 || p === 58 ? getColorWidth(args, i) : 1
      switch (this._applyArgs[0]) {
        case 1:
          if (p === 2) {
            this._undoArgs = [22, 2]
          } else if (p === 22 || p === 0) {
            this._undoArgs = [22]
          }
          break
        case 2:
          if (p === 1) {
            this._undoArgs = [22, 1]
          } else if (p === 22 || p === 0) {
            this._undoArgs = [22]
          }
          break
        case 38:
          if (p === 0 || p === 39 || p === 100) {
            this._undoArgs = [39]
          } else if ((p >= 30 && p <= 38) || (p >= 90 && p <= 97)) {
            this._undoArgs = args.slice(i, i + width) as number[]
          }
          break
        default:
          if (p === this._applyArgs[0]) {
            this._undoArgs = this._applyArgs
          } else if (p === 0) {
            this._undoArgs = this._originalUndoArgs
          }
      }

      i += width
    }

    if (originalUndo !== this._undoArgs) {
      this.undo = TypeAheadStyle._compileArgs(this._undoArgs)
    }
  }

  onUpdate(style: ITypeAheadConfig['style']) {
    const { applyArgs, undoArgs } = this._getArgs(style)
    this._applyArgs = applyArgs
    this._originalUndoArgs = undoArgs
    this._undoArgs = undoArgs
    this.apply = TypeAheadStyle._compileArgs(this._applyArgs)
    this.undo = TypeAheadStyle._compileArgs(this._undoArgs)
  }

  private _getArgs(style: ITypeAheadConfig['style']) {
    switch (style) {
      case 'bold':
        return { applyArgs: [1], undoArgs: [22] }
      case 'dim':
        return { applyArgs: [2], undoArgs: [22] }
      case 'italic':
        return { applyArgs: [3], undoArgs: [23] }
      case 'underlined':
        return { applyArgs: [4], undoArgs: [24] }
      case 'inverted':
        return { applyArgs: [7], undoArgs: [27] }
      default: {
        // Parse hex color: #RRGGBB
        const hex = style.replace(HEX_PREFIX_RE, '')
        const r = Number.parseInt(hex.slice(0, 2), 16) || 255
        const g = Number.parseInt(hex.slice(2, 4), 16) || 0
        const b = Number.parseInt(hex.slice(4, 6), 16) || 0
        return { applyArgs: [38, 2, r, g, b], undoArgs: [39] }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Compile exclude regexp
// ---------------------------------------------------------------------------

const compileExcludeRegexp = (
  programs: readonly string[] = DEFAULT_CONFIG.excludePrograms
) =>
  new RegExp(`\\b(${programs.map(escapeRegExpCharacters).join('|')})\\b`, 'i')

// ---------------------------------------------------------------------------
// CharPredictState
// ---------------------------------------------------------------------------

export const CharPredictState = {
  /** No characters typed on this line yet */
  Unknown: 0,
  /** Has a pending character prediction */
  HasPendingChar: 1,
  /** Character validated on this line */
  Validated: 2,
} as const
export type CharPredictState =
  (typeof CharPredictState)[keyof typeof CharPredictState]

// ---------------------------------------------------------------------------
// TypeAheadAddon
// ---------------------------------------------------------------------------

export class TypeAheadAddon extends Disposable implements ITerminalAddon {
  private _typeaheadStyle: TypeAheadStyle | undefined
  private readonly _typeaheadThreshold: number
  private readonly _excludeProgramRe: RegExp
  protected _lastRow:
    | {
        y: number
        startingX: number
        endingX: number
        charState: CharPredictState
      }
    | undefined
  protected _timeline: PredictionTimeline | undefined
  private _terminalTitle = ''
  stats: PredictionStats | undefined

  private _clearPredictionTimeout: ReturnType<typeof setTimeout> | undefined
  private _reevaluateTimeout: ReturnType<typeof setTimeout> | undefined

  private readonly _processManager: ITypeAheadProcessManager
  private readonly _config: ITypeAheadConfig

  constructor(
    processManager: ITypeAheadProcessManager,
    config: ITypeAheadConfig = DEFAULT_CONFIG
  ) {
    super()
    this._processManager = processManager
    this._config = config
    this._typeaheadThreshold = config.latencyThreshold
    this._excludeProgramRe = compileExcludeRegexp(config.excludePrograms)
    this._register(
      toDisposable(() => {
        if (this._clearPredictionTimeout !== undefined) {
          clearTimeout(this._clearPredictionTimeout)
        }
        if (this._reevaluateTimeout !== undefined) {
          clearTimeout(this._reevaluateTimeout)
        }
      })
    )
  }

  activate(terminal: Terminal): void {
    const style = new TypeAheadStyle(this._config.style, terminal)
    this._typeaheadStyle = style
    this._register(style)

    const timeline = new PredictionTimeline(terminal, style)
    this._timeline = timeline
    this._register(timeline)

    const stats = new PredictionStats(timeline)
    this.stats = stats
    this._register(stats)

    timeline.setShowPredictions(this._typeaheadThreshold === 0)
    this._register(terminal.onData((e) => this._onUserData(e)))
    this._register(
      terminal.onTitleChange((title) => {
        this._terminalTitle = title
        this._reevaluatePredictorState(stats, timeline)
      })
    )
    this._register(
      terminal.onResize(() => {
        timeline.setShowPredictions(false)
        timeline.clearCursor()
        this._reevaluatePredictorState(stats, timeline)
      })
    )
    this._register(
      timeline.onPredictionSucceeded((p) => {
        if (
          this._lastRow?.charState === CharPredictState.HasPendingChar &&
          isTenativeCharacterPrediction(p) &&
          p.inner.appliedAt &&
          p.inner.appliedAt.pos.y + p.inner.appliedAt.pos.baseY ===
            this._lastRow.y
        ) {
          this._lastRow.charState = CharPredictState.Validated
        }
      })
    )
    this._register(
      this._processManager.onBeforeProcessData((e) =>
        this._onBeforeProcessData(e)
      )
    )

    this._register(
      stats.onChange(() => {
        if (timeline.length === 0) {
          style.debounceStopTracking()
        }

        this._reevaluatePredictorState(stats, timeline)
      })
    )
  }

  reset() {
    this._lastRow = undefined
  }

  private _deferClearingPredictions() {
    if (!(this.stats && this._timeline)) {
      return
    }

    if (this._clearPredictionTimeout !== undefined) {
      clearTimeout(this._clearPredictionTimeout)
    }
    if (
      this._timeline.length === 0 ||
      this._timeline.peekStart()?.clearAfterTimeout === false
    ) {
      this._clearPredictionTimeout = undefined
      return
    }

    this._clearPredictionTimeout = setTimeout(
      () => {
        this._timeline?.undoAllPredictions()
        if (this._lastRow?.charState === CharPredictState.HasPendingChar) {
          this._lastRow.charState = CharPredictState.Unknown
        }
      },
      Math.max(500, (this.stats.maxLatency * 3) / 2)
    )
  }

  // Debounced: only re-evaluate after a 100ms pause
  protected _reevaluatePredictorState(
    stats: PredictionStats,
    timeline: PredictionTimeline
  ) {
    if (this._reevaluateTimeout !== undefined) {
      clearTimeout(this._reevaluateTimeout)
    }
    this._reevaluateTimeout = setTimeout(() => {
      this._reevaluateTimeout = undefined
      this._reevaluatePredictorStateNow(stats, timeline)
    }, 100)
  }

  protected _reevaluatePredictorStateNow(
    stats: PredictionStats,
    timeline: PredictionTimeline
  ) {
    if (this._excludeProgramRe.test(this._terminalTitle)) {
      timeline.setShowPredictions(false)
    } else if (this._typeaheadThreshold < 0) {
      timeline.setShowPredictions(false)
    } else if (this._typeaheadThreshold === 0) {
      timeline.setShowPredictions(true)
    } else if (
      stats.sampleSize > StatsConstants.StatsMinSamplesToTurnOn &&
      stats.accuracy > StatsConstants.StatsMinAccuracyToTurnOn
    ) {
      const latency = stats.latency.median
      if (latency !== undefined && latency >= this._typeaheadThreshold) {
        timeline.setShowPredictions(true)
      } else if (
        latency !== undefined &&
        latency <
          this._typeaheadThreshold / StatsConstants.StatsToggleOffThreshold
      ) {
        timeline.setShowPredictions(false)
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported from VS Code — user input parsing requires sequential character type detection
  private _onUserData(data: string): void {
    if (this._timeline?.terminal.buffer.active.type !== 'normal') {
      return
    }

    const terminal = this._timeline.terminal
    const buffer = terminal.buffer.active

    // Detect programs like git log/less that use the normal buffer but don't
    // take input by default (fixes #109541)
    if (
      buffer.cursorX === 1 &&
      buffer.cursorY === terminal.rows - 1 &&
      buffer
        .getLine(buffer.cursorY + buffer.baseY)
        ?.getCell(0)
        ?.getChars() === ':'
    ) {
      return
    }

    // Guard the terminal prompt to avoid being able to arrow or backspace
    // into the prompt
    const actualY = buffer.baseY + buffer.cursorY
    if (actualY !== this._lastRow?.y) {
      this._lastRow = {
        y: actualY,
        startingX: buffer.cursorX,
        endingX: buffer.cursorX,
        charState: CharPredictState.Unknown,
      }
    } else {
      this._lastRow.startingX = Math.min(
        this._lastRow.startingX,
        buffer.cursorX
      )
      this._lastRow.endingX = Math.max(
        this._lastRow.endingX,
        this._timeline.physicalCursor(buffer).x
      )
    }

    const timeline = this._timeline
    const lastRow = this._lastRow
    const typeaheadStyle = this._typeaheadStyle

    const addLeftNavigating = (p: IPrediction) =>
      timeline.tentativeCursor(buffer).x <= lastRow.startingX
        ? timeline.addBoundary(buffer, p)
        : timeline.addPrediction(buffer, p)

    const addRightNavigating = (p: IPrediction) =>
      timeline.tentativeCursor(buffer).x >= lastRow.endingX - 1
        ? timeline.addBoundary(buffer, p)
        : timeline.addPrediction(buffer, p)

    const reader = new StringReader(data)
    while (reader.remaining > 0) {
      if (reader.eatCharCode(127)) {
        // backspace
        const previous = timeline.peekEnd()
        if (previous instanceof CharacterPrediction) {
          timeline.addBoundary()
        }

        if (timeline.isShowingPredictions) {
          flushOutput(timeline.terminal)
        }

        if (timeline.tentativeCursor(buffer).x <= lastRow.startingX) {
          timeline.addBoundary(
            buffer,
            new BackspacePrediction(timeline.terminal)
          )
        } else {
          lastRow.endingX--
          timeline.addPrediction(
            buffer,
            new BackspacePrediction(timeline.terminal)
          )
        }

        continue
      }

      if (reader.eatCharCode(32, 126)) {
        // printable ASCII
        const char = data[reader.index - 1]
        if (char === undefined) {
          break
        }
        if (!typeaheadStyle) {
          break
        }
        const prediction = new CharacterPrediction(typeaheadStyle, char)
        if (lastRow.charState === CharPredictState.Unknown) {
          timeline.addBoundary(buffer, prediction)
          lastRow.charState = CharPredictState.HasPendingChar
        } else {
          timeline.addPrediction(buffer, prediction)
        }

        if (timeline.tentativeCursor(buffer).x >= terminal.cols) {
          timeline.addBoundary(buffer, new LinewrapPrediction())
        }
        continue
      }

      const cursorMv = reader.eatRe(CSI_MOVE_RE)
      if (cursorMv) {
        const direction = cursorMv[3] as CursorMoveDirection
        const p = new CursorMovePrediction(
          direction,
          !!cursorMv[2],
          Number(cursorMv[1]) || 1
        )
        if (direction === CursorMoveDirection.Back) {
          addLeftNavigating(p)
        } else {
          addRightNavigating(p)
        }
        continue
      }

      if (reader.eatStr(`${VT.Esc}f`)) {
        addRightNavigating(
          new CursorMovePrediction(CursorMoveDirection.Forwards, true, 1)
        )
        continue
      }

      if (reader.eatStr(`${VT.Esc}b`)) {
        addLeftNavigating(
          new CursorMovePrediction(CursorMoveDirection.Back, true, 1)
        )
        continue
      }

      if (reader.eatChar('\r') && buffer.cursorY < terminal.rows - 1) {
        timeline.addPrediction(buffer, new NewlinePrediction())
        continue
      }

      // something else — hard boundary
      timeline.addBoundary(buffer, new HardBoundary())
      break
    }

    if (timeline.length === 1) {
      this._deferClearingPredictions()
      typeaheadStyle?.startTracking()
    }
  }

  private _onBeforeProcessData(event: IBeforeProcessDataEvent): void {
    if (!this._timeline) {
      return
    }

    event.data = this._timeline.beforeServerInput(event.data)

    this._deferClearingPredictions()
  }
}
