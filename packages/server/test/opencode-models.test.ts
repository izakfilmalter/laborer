/**
 * The model list comes off a CLI's stdout, so it has to survive stdout.
 *
 * `opencode2 models` prints one id per line, but a background service that is
 * warming up can put its own lines in front of them. Offering one of those as
 * a model would put an unusable value into the setting.
 *
 * @see packages/server/src/services/opencode-models.ts
 */

import { describe, expect, it } from 'vitest'
import { parseModelList } from '../src/services/opencode-models.js'

describe('parseModelList', () => {
  it('reads the ids OpenCode printed', () => {
    expect(
      parseModelList('anthropic/claude-opus-5\nopenai/gpt-5.6-sol-fast\n')
    ).toEqual(['anthropic/claude-opus-5', 'openai/gpt-5.6-sol-fast'])
  })

  it('keeps ids whose tail carries its own slashes', () => {
    expect(parseModelList('openrouter/meta/llama-4\n')).toEqual([
      'openrouter/meta/llama-4',
    ])
  })

  it('drops chatter that is not a model id', () => {
    const models = parseModelList(
      ['starting server...', '', 'anthropic/claude-opus-5', 'done'].join('\n')
    )

    expect(models).toEqual(['anthropic/claude-opus-5'])
  })

  it('sorts and de-duplicates so the picker is stable', () => {
    expect(
      parseModelList('openai/gpt-5.4\nanthropic/x\nopenai/gpt-5.4\n')
    ).toEqual(['anthropic/x', 'openai/gpt-5.4'])
  })

  it('reports nothing rather than failing when OpenCode is signed out', () => {
    expect(parseModelList('')).toEqual([])
  })
})
