/**
 * Turning the current block into another kind of block.
 *
 * Picking "Heading 1" from the slash menu on an empty paragraph should replace
 * that paragraph, not leave an empty one above the new heading — so every
 * insertion here cleans up the block it was invoked from.
 */

'use client'

import { insertCodeBlock } from '@platejs/code-block'
import { KEYS, type Path, PathApi } from 'platejs'
import type { PlateEditor } from 'platejs/react'

/** Plate models list items as indented blocks, not as nested `<ul>` nodes. */
function insertList(editor: PlateEditor, type: string) {
  editor.tf.insertNodes(
    editor.api.create.block({ indent: 1, listStyleType: type }),
    { select: true }
  )
}

const INSERTERS: Record<string, (editor: PlateEditor, type: string) => void> = {
  [KEYS.codeBlock]: (editor) => insertCodeBlock(editor, { select: true }),
  [KEYS.listTodo]: insertList,
  [KEYS.ol]: insertList,
  [KEYS.ul]: insertList,
}

/** What kind of block this is, counting a list's style as its type. */
function getBlockType(
  block: { type?: string } & Record<string, unknown>
): string | undefined {
  const listType = block[KEYS.listType]
  if (listType) {
    if (listType === KEYS.ol) {
      return KEYS.ol
    }
    if (listType === KEYS.listTodo) {
      return KEYS.listTodo
    }
    return KEYS.ul
  }
  return block.type
}

function insertBlock(
  editor: PlateEditor,
  type: string,
  { upsert = false }: { readonly upsert?: boolean } = {}
) {
  editor.tf.withoutNormalizing(() => {
    const entry = editor.api.block()
    if (!entry) {
      return
    }

    const [node, path] = entry
    const isEmpty = editor.api.isEmpty(node)
    const isSameType = type === getBlockType(node)

    // Already sitting in an empty block of the requested type: nothing to do,
    // and inserting would leave a blank one behind.
    if (upsert && isEmpty && isSameType) {
      return
    }

    if (type === KEYS.blockquote) {
      const insertPath = PathApi.next(path)
      editor.tf.insertNodes(
        {
          children: [editor.api.create.block({ type: KEYS.p })],
          type: KEYS.blockquote,
        },
        { at: insertPath }
      )
      if (!isSameType && isEmpty) {
        editor.tf.removeNodes({ at: path })
      }
      selectStart(editor, isEmpty && !isSameType ? path : insertPath)
      return
    }

    const inserter = INSERTERS[type]
    if (inserter) {
      inserter(editor, type)
    } else {
      editor.tf.insertNodes(editor.api.create.block({ type }), {
        at: PathApi.next(path),
        select: true,
      })
    }

    if (!isSameType) {
      editor.tf.removeNodes({ previousEmptyBlock: true })
    }
  })
}

/** Put the caret inside a freshly created wrapper block. */
function selectStart(editor: PlateEditor, path: Path) {
  const start = editor.api.start(path.concat([0]))
  if (start) {
    editor.tf.select(start)
  }
}

export { getBlockType, insertBlock }
