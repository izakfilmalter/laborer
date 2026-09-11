#!/usr/bin/env node

// Offline TUI workload, not an OpenCode emulator. Run in the diagnostic PTY to
// compare raw echo with alternate-screen, styled full-grid redraws on input.
import process from 'node:process'

const ESC = '\x1b'
const CSI = `${ESC}[`
const synchronized = process.env.TUI_SYNC !== '0'
const redraw = process.env.TUI_REDRAW ?? 'full'
if (redraw !== 'full' && redraw !== 'prompt') {
  throw new Error('TUI_REDRAW must be full or prompt')
}
const backgroundFps = Number(process.env.TUI_BACKGROUND_FPS ?? 0)
if (
  !Number.isFinite(backgroundFps) ||
  backgroundFps < 0 ||
  backgroundFps > 120
) {
  throw new Error('TUI_BACKGROUND_FPS must be between 0 and 120')
}
if (!(process.stdin.isTTY && process.stdout.isTTY)) {
  throw new Error('Run this fixture inside the diagnostic PTY')
}

let input = ''
let frame = 0
let blocked = false
let pending = false
let exiting = false
let escape = ''
let timer

function draw() {
  if (exiting) {
    return
  }
  if (blocked) {
    pending = true
    return
  }
  pending = false
  frame += 1
  const cols = Math.max(10, process.stdout.columns || 80)
  const rows = Math.max(4, process.stdout.rows || 24)
  const width = cols - 1
  const promptLines = Math.min(6, rows - 2)
  const promptWidth = width
  const prompt = input.slice(-promptWidth * promptLines)
  let output = synchronized ? `${CSI}?2026h` : ''
  output += `${CSI}?25l`
  const firstRow = frame === 1 || redraw === 'full' ? 1 : rows - promptLines + 1
  for (let row = firstRow; row <= rows; row += 1) {
    output += `${CSI}${row};1H${CSI}0m${CSI}2K`
    if (row === 1) {
      output += `${CSI}1;36m${`TUI redraw probe | frame ${frame} | Ctrl+C exits`.slice(0, width)}`
    } else if (row < rows - promptLines) {
      const label = `row ${String(row).padStart(2, '0')}  parsing styled output `
      output += `${CSI}${row % 2 === 0 ? '32' : '35'}m${label.repeat(Math.ceil(width / label.length)).slice(0, width)}`
    } else if (row === rows - promptLines) {
      output += `${CSI}2m${'Type here; each input redraws the grid:'.slice(0, width)}`
    } else {
      const start = (row - (rows - promptLines) - 1) * promptWidth
      output += `${CSI}0m${prompt.slice(start, start + promptWidth)}`
    }
  }
  const cursorRow = Math.min(
    rows,
    rows - promptLines + 1 + Math.floor(prompt.length / promptWidth)
  )
  const cursorCol = Math.min(cols, 1 + (prompt.length % promptWidth))
  output += `${CSI}${cursorRow};${cursorCol}H${CSI}?25h`
  if (synchronized) {
    output += `${CSI}?2026l`
  }
  blocked = !process.stdout.write(output)
}

function finish() {
  if (exiting) {
    return
  }
  exiting = true
  clearInterval(timer)
  process.stdin.setRawMode(false)
  process.stdin.pause()
  process.stdout.write(`${CSI}?2026l${CSI}0m${CSI}?25h${CSI}?1049l`, () => {
    process.exit(0)
  })
}

process.stdout.on('drain', () => {
  blocked = false
  if (pending) {
    draw()
  }
})
process.stdout.on('resize', () => {
  frame = 0
  draw()
})
process.on('SIGTERM', finish)
process.on('SIGINT', finish)
process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
function receiveCharacter(character) {
  if (character === '\x03') {
    finish()
    return
  }
  // Ignore terminal reports/navigation CSI sequences; the generated workload
  // uses plain printable input. It deliberately does not negotiate Kitty.
  if (escape.length > 0) {
    escape += character
    if (
      (escape.length > 2 && character >= '@' && character <= '~') ||
      (escape.length === 2 && character !== '[') ||
      escape.length > 128
    ) {
      escape = ''
    }
    return
  }
  if (character === ESC) {
    escape = ESC
  } else if (character === '\x7f' || character === '\b') {
    input = input.slice(0, -1)
  } else if (character === '\r' || character === '\n' || character === '\x15') {
    input = ''
  } else if (character >= ' ') {
    input = `${input}${character}`.slice(-4096)
  }
}

process.stdin.on('data', (data) => {
  for (const character of data) {
    receiveCharacter(character)
    if (exiting) {
      return
    }
  }
  draw()
})

process.stdout.write(`${CSI}?1049h${CSI}2J`)
draw()
if (backgroundFps > 0) {
  timer = setInterval(draw, 1000 / backgroundFps)
}
