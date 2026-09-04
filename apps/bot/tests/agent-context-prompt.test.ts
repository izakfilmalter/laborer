import { assert, describe, it } from '@effect/vitest'
import {
  DEFAULT_SOUL,
  LABORER_INSTRUCTIONS,
  renderAcpPrompt,
} from '../src/acp-runtime/agent-context.ts'
import { NormalizedMessage, stableMessageId } from '../src/core/domain.ts'
import type { ConversationAgentRequest } from '../src/reference-coding-application.ts'

const normalized = (
  text: string,
  classification: 'context' | 'input',
  ts: string
): NormalizedMessage =>
  new NormalizedMessage({
    authorKind: 'human',
    authorSlackId: 'U-HUMAN',
    classification,
    id: stableMessageId('C1', ts, 'TFIRST'),
    images: [],
    isActivation: classification === 'input',
    slackTs: ts,
    text,
  })

const request = (
  context: readonly NormalizedMessage[],
  messages: readonly NormalizedMessage[]
): ConversationAgentRequest => ({
  actions: [],
  context,
  conversationId: 'workspace:TFIRST:C1:1.000',
  conversationSessionId: 'session',
  conversationSessionIsNew: true,
  executionControls: [],
  executions: [],
  input: messages.map((message) => message.text).join('\n'),
  messages,
  promptId: 'prompt',
  source: 'slack',
  turnId: 'turn',
})

describe('ACP prompt rendering', () => {
  it('sends Laborer operating instructions with the initial Soul', () => {
    const prompt = renderAcpPrompt(
      request(
        [normalized('root discussion', 'context', '1.000')],
        [normalized('@laborer do the thing', 'input', '2.000')]
      ),
      { participants: [], soul: DEFAULT_SOUL, workspaceMemory: null }
    )

    assert.ok(prompt.startsWith('<laborer-instructions>'))
    assert.ok(prompt.includes(LABORER_INSTRUCTIONS))
    assert.ok(prompt.includes(`<soul>${DEFAULT_SOUL}</soul>`))
    assert.ok(LABORER_INSTRUCTIONS.includes('create-feature'))
    assert.ok(LABORER_INSTRUCTIONS.includes('deal-with-bug'))
    assert.ok(LABORER_INSTRUCTIONS.includes('NO_REPLY'))
    assert.ok(
      prompt.indexOf('classification="context"') <
        prompt.indexOf('classification="input"')
    )
  })

  it('omits instructions on follow-up turns that carry no Soul', () => {
    const prompt = renderAcpPrompt(
      request([], [normalized('follow up', 'input', '3.000')]),
      { participants: [], soul: null, workspaceMemory: null }
    )

    assert.ok(!prompt.includes('<laborer-instructions>'))
    assert.ok(!prompt.includes('<soul>'))
    assert.ok(prompt.startsWith('<slack-messages>'))
  })
})
