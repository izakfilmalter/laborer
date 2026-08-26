import { describe, expect, it } from 'vitest'
import { resolveDiffHeaderClick } from '@/lib/diff-header-click'

/**
 * Rebuilds the shape `@pierre/diffs` paints for a file header, and the
 * innermost-first composed path a click inside it produces.
 */
const buildHeader = (filePath: string) => {
  const header = document.createElement('div')
  header.setAttribute('data-diffs-header', 'default')

  const content = document.createElement('div')
  content.setAttribute('data-header-content', '')

  const chevron = document.createElement('button')
  chevron.type = 'button'
  content.append(chevron)

  const title = document.createElement('div')
  title.setAttribute('data-title', '')
  const bdi = document.createElement('bdi')
  bdi.textContent = filePath
  title.append(bdi)
  content.append(title)

  const metadata = document.createElement('div')
  metadata.setAttribute('data-metadata', '')
  const openButton = document.createElement('button')
  openButton.type = 'button'
  openButton.textContent = 'Open'
  metadata.append(openButton)

  header.append(content, metadata)

  return { bdi, chevron, content, header, openButton, title }
}

/** The path `composedPath()` reports: the target, then its ancestors. */
const composedPathFrom = (node: Element): readonly EventTarget[] => {
  const path: EventTarget[] = []
  let current: Element | null = node
  while (current) {
    path.push(current)
    current = current.parentElement
  }
  return path
}

describe('resolveDiffHeaderClick', () => {
  it('opens the file when the filename is clicked', () => {
    const { bdi } = buildHeader('src/example.ts')

    expect(resolveDiffHeaderClick(composedPathFrom(bdi))).toEqual({
      kind: 'open',
      path: 'src/example.ts',
    })
  })

  it('toggles the file when the header row itself is clicked', () => {
    const { content, header } = buildHeader('src/example.ts')

    expect(resolveDiffHeaderClick(composedPathFrom(header))).toEqual({
      kind: 'toggle',
      path: 'src/example.ts',
    })
    // The row between the controls is still the row.
    expect(resolveDiffHeaderClick(composedPathFrom(content))).toEqual({
      kind: 'toggle',
      path: 'src/example.ts',
    })
  })

  it('leaves the header controls their own actions', () => {
    const { chevron, openButton } = buildHeader('src/example.ts')

    // Otherwise the chevron toggle and the row toggle cancel each other.
    expect(resolveDiffHeaderClick(composedPathFrom(chevron)).kind).toBe(
      'ignore'
    )
    expect(resolveDiffHeaderClick(composedPathFrom(openButton)).kind).toBe(
      'ignore'
    )
  })

  it('ignores a click on a link inside a header', () => {
    const { header } = buildHeader('src/example.ts')
    const link = document.createElement('a')
    link.href = '#'
    header.append(link)

    expect(resolveDiffHeaderClick(composedPathFrom(link)).kind).toBe('ignore')
  })

  it('ignores clicks in the diff body, so selecting code stays selecting', () => {
    const line = document.createElement('div')
    line.setAttribute('data-line', '')
    const body = document.createElement('div')
    body.append(line)

    expect(resolveDiffHeaderClick(composedPathFrom(line)).kind).toBe('ignore')
  })

  it('ignores the line-number column, so dragging it selects lines', () => {
    // With `enableLineSelection` on, a press on the number column starts
    // a line selection. Resolving that to a header action would collapse
    // or open the file out from under the drag.
    const gutter = document.createElement('div')
    gutter.setAttribute('data-column-number', '12')
    const pre = document.createElement('pre')
    pre.append(gutter)

    expect(resolveDiffHeaderClick(composedPathFrom(gutter)).kind).toBe('ignore')
  })

  it('ignores the gutter comment button parked inside the number column', () => {
    // The viewer slots the app's gutter affordance into the number
    // column, so its composed path runs through the same nodes a line
    // click does. It is a button, which the walk hands its own action.
    const gutter = document.createElement('div')
    gutter.setAttribute('data-column-number', '12')
    const slot = document.createElement('div')
    slot.setAttribute('data-gutter-utility-slot', '')
    const commentButton = document.createElement('button')
    commentButton.type = 'button'
    slot.append(commentButton)
    gutter.append(slot)

    expect(resolveDiffHeaderClick(composedPathFrom(commentButton)).kind).toBe(
      'ignore'
    )
  })

  it('ignores a header with no resolvable filename', () => {
    const header = document.createElement('div')
    header.setAttribute('data-diffs-header', 'custom')

    expect(resolveDiffHeaderClick(composedPathFrom(header)).kind).toBe('ignore')
  })

  it('ignores non-element entries such as the document and window', () => {
    expect(resolveDiffHeaderClick([document, window]).kind).toBe('ignore')
  })
})
