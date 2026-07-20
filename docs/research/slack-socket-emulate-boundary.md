# Slack Socket Mode and Emulate test boundary

Status: recommendation for [issue 200](https://github.com/izakfilmalter/laborer/issues/200), researched 2026-07-20. Slack source links are pinned to Node Slack SDK commit `1e3c0c5d7bab1e519535abe6ee67db740afe7101`; Emulate links are pinned to commit `1e4b71a1da6e8c937318958bebf03bcb87d61dd5` (package 0.9.0).

## Decision

Use Slack's official low-level Node/TypeScript SDK packages for the Runner:

- `@slack/socket-mode@3.0.0` for the production inbound transport;
- `@slack/web-api@8.0.0` for Web API reads and writes; and
- `emulate@0.9.0` only behind the outbound Web API adapter in integration tests.

These current official packages declare Node >=20 support, and Socket Mode depends on the matching `@slack/web-api` major. [Socket Mode package](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/socket-mode/package.json#L1-L28) [Socket Mode dependency](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/socket-mode/package.json#L53-L60) [Web API package](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/web-api/package.json#L1-L25)

Slack also recommends Bolt for Socket Mode apps, and `@slack/bolt@5.0.0` is current. Bolt is preferable when an app needs its listener routing, middleware, OAuth, or interactivity abstractions. It is not recommended here: this Runner needs one narrow Events API transport and an explicit injectable domain boundary. Slack's guide recommends Bolt *or the SDKs*, and the low-level SDK exposes explicit receipt and `ack()` seams. [Slack Socket Mode guide](https://docs.slack.dev/apis/events-api/using-socket-mode/#sdks) [Node SDK Socket Mode](https://docs.slack.dev/tools/node-slack-sdk/socket-mode/)

## Recommended seams

Define ports owned by Laborer, not the SDK:

```ts
interface SlackInboundEvent {
  readonly deliveryId: string // Socket envelope_id
  readonly eventId: string // Events API body.event_id
  readonly retryAttempt: number | undefined
  readonly retryReason: string | undefined
  readonly teamId: string
  readonly type: string
  readonly event: Record<string, unknown>
}

interface SlackInboundSink {
  accept(event: SlackInboundEvent): Promise<"accepted" | "duplicate">
}

interface SlackThreadGateway {
  readCompleteThread(channelId: string, rootTs: string): Promise<SlackMessage[]>
  reply(channelId: string, rootTs: string, text: string): Promise<void>
}
```

The exact names can change; the important boundary is **normalized event in, domain-level thread operations out**. Do not leak `SocketModeClient`, `WebClient`, or raw Slack payload unions past the Slack integration module.

### 1. Real Socket Mode receipt and acknowledgements

In production, create `new SocketModeClient({ appToken })`, register on its generic `slack_event` emitter, and call `await client.start()`. For `events_api` envelopes, normalize `body.event_id`, `body.team_id`, `body.event`, `envelope_id`, `retry_num`, and `retry_reason`. The emitter provides `ack`, envelope ID, body, and retry metadata; `ack()` sends the envelope ID over the socket. [SocketModeClient dispatch](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/socket-mode/src/SocketModeClient.ts#L317-L404)

For an Events API event, call `ack()` without an application payload. Do not wait for thread reading, workspace creation, or a reply. Slack requires acknowledgement of each Socket Mode envelope and specifies that the acknowledgement contains `envelope_id`. [Socket Mode acknowledgement](https://docs.slack.dev/apis/events-api/using-socket-mode/#acknowledge)

**Ack policy:** validate and atomically insert the normalized event into durable work with a unique constraint on `eventId`; then ack both new events and duplicates. If durable insertion fails, omit/fail the ack so Slack can redeliver. This keeps acknowledgement short without acknowledging volatile work. Slack describes `event_id` as globally unique, while the Socket client exposes separate retry metadata. [Event callback fields](https://docs.slack.dev/apis/events-api/#callback-field) [Socket retry fields](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/socket-mode/src/SocketModeClient.ts#L323-L393)

Treat receipt as at-least-once. `event_id` is the logical-event idempotency key; `envelope_id` is the delivery/ack identifier. `retryAttempt` and `retryReason` are observability fields, not deduplication keys.

### 2. Overriding the Slack Web API base URL

Construct the outbound test client as:

```ts
const web = new WebClient(botToken, {
  slackApiUrl: `${emulator.url}/api/`,
})
```

`slackApiUrl` is the official `WebClientOptions` seam, and the client normalizes a missing trailing slash. [WebClient option](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/web-api/src/WebClient.ts#L43-L72) [Emulate's real-SDK test](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/packages/@emulators/slack/src/__tests__/slack-sdk.test.ts#L20-L22)

**Keep clients separate.** Do not set Socket Mode's internal `clientOptions.slackApiUrl` to Emulate. `SocketModeClient.start()` first calls `apps.connections.open` through its internal Web client to obtain the runtime `wss:` URL; Emulate implements neither that method nor Socket Mode. [Socket connection setup](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/socket-mode/src/SocketModeClient.ts#L108-L150) [Emulate Socket Mode gap](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/packages/@emulators/slack/src/__tests__/slack-coverage.ts#L587-L592)

### 3. Reading a complete thread

Call `conversations.replies({ channel: channelId, ts: rootTs, limit, cursor })` until `response_metadata.next_cursor` is empty. The first message is the root; following messages are replies. Slack documents cursor pagination and warns that fewer than `limit` may be returned. [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/)

`WebClient.paginate("conversations.replies", { channel, ts, limit })` is the SDK's public async-iterator seam and forwards cursors until no next cursor remains. [WebClient pagination](https://github.com/slackapi/node-slack-sdk/blob/1e3c0c5d7bab1e519535abe6ee67db740afe7101/packages/web-api/src/WebClient.ts#L324-L374) The gateway should flatten and validate every page's `messages` before returning domain `SlackMessage[]`.

Do not rely on a default page size. As of the research date, `conversations.replies` is limited to 15 objects/request for new non-Marketplace commercial distributions, while internal customer-built apps retain Tier 3 rates. [Slack rate note](https://docs.slack.dev/reference/methods/conversations.replies/#usage-info)

### 4. Posting a thread reply

Call:

```ts
await web.chat.postMessage({
  channel: channelId,
  text,
  thread_ts: rootTs,
})
```

`thread_ts` must be the parent's `ts`, not a reply's `ts`. Use `reply_broadcast: true` only when the reply should also appear in the channel. [`chat.postMessage` threads](https://docs.slack.dev/reference/methods/chat.postMessage/#threads)

Emulate persists replies, updates the parent's reply count/users, and round-trips the result through a real `WebClient`. [Emulate implementation](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/packages/@emulators/slack/src/routes/chat.ts#L115-L186) [Emulate SDK thread test](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/packages/@emulators/slack/src/__tests__/slack-sdk.test.ts#L98-L134)

### 5. Deduplicating and retrying

Split retry responsibility:

- **Inbound delivery:** Slack can redeliver until acknowledged. Deduplicate durable work by `event_id`; ack after the idempotent durable insert.
- **Business work:** the durable queue/workflow retries thread reading, workspace creation, and replying. Keep operations idempotent. For replies, retain the resulting message `ts` and consider a stable `client_msg_id` if the domain can generate one.
- **Outbound HTTP:** `@slack/web-api` retries transport failures and `429` throttling; its default is ten retries over about 30 minutes. This is distinct from domain retries and does not guarantee exactly-once posting. [Web API automatic retries](https://docs.slack.dev/tools/node-slack-sdk/web-api/#automatic-retries)

### 6. Injecting normalized inbound events in tests

Integration tests should call the same `SlackInboundSink.accept` used by the real transport, passing a hand-built `SlackInboundEvent`. Test the transport adapter separately with representative raw `events_api` fixtures and a recording `ack` fake. This exercises normalization, acknowledgement ordering, retry metadata propagation, and durable dedupe without a WebSocket.

Do not instantiate `SocketModeClient` in Emulate tests. Emulate explicitly does not implement Socket Mode, and redirecting the client would fail at `apps.connections.open`. [Emulate limits](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/README.md#L833-L838)

## What Emulate verifies — and what it does not

### Verified today

With `strict_scopes: true` and seeded users/channels/tokens, Emulate is a stateful integration boundary for:

- real `@slack/web-api` serialization and typed methods;
- `chat.postMessage` persistence, thread linkage, and parent reply counts;
- `conversations.replies` returning root + replies in timestamp order;
- supported scope and conversation-membership errors; and
- state reset between tests.

Its programmatic API exposes `createEmulator({ service: "slack", seed })`, `url`, `reset()`, and `close()`. [Emulate programmatic API](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/README.md#L104-L162) Its suite runs the real `WebClient` and round-trips thread writes/reads. [Emulate SDK test](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/packages/@emulators/slack/src/__tests__/slack-sdk.test.ts#L98-L134)

### Explicit gaps — test elsewhere

- **Socket Mode protocol:** `apps.connections.open`, WebSocket handshake, hello/disconnect/reconnect, ping/pong, envelope ack, timeout, redelivery, and connection distribution are outside Emulate. [Emulate limits](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/README.md#L833-L838)
- **Event delivery fidelity:** normalized injection does not test app subscription configuration, Slack visibility, ordering/concurrency, rate limiting, retry schedule, or actual duplicate delivery. Emulate can send supported `event_callback` payloads to configured HTTP webhook URLs, but that is not Socket Mode. [Emulate Slack surface](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/README.md#L755-L757)
- **Thread pagination and production rates:** Emulate's current `conversations.replies` ignores `limit`, `cursor`, and time bounds, returns the whole thread, hard-codes `has_more: false`, and omits `response_metadata.next_cursor`. An Emulate-green test cannot prove pagination; also test the gateway with a multi-page fake. [Emulate replies implementation](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/packages/@emulators/slack/src/routes/conversations.ts#L473-L500)
- **Thread edge fidelity:** current Emulate `chat.postMessage` does not reject an unknown `thread_ts`; it stores the message and merely skips parent updating. It also does not exercise Slack's `reply_broadcast` presentation. [Emulate chat implementation](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/packages/@emulators/slack/src/routes/chat.ts#L115-L186)
- **Other production behavior:** exact rate limiting, paid-plan behavior, Slack Connect, Enterprise/admin APIs, slash-command/interactivity simulation, and the other surfaces in Emulate's current limits list must not be asserted here. [Emulate limits](https://github.com/vercel-labs/emulate/blob/1e4b71a1da6e8c937318958bebf03bcb87d61dd5/README.md#L833-L838)

## Test matrix

| Test layer | Real transport? | Web API target | What it proves |
| --- | --- | --- | --- |
| Unit: Socket adapter | No | Recording fake | Raw envelope → normalized event; ack ordering/failure; retry metadata. |
| Unit: thread gateway | No | Multi-page fake | Complete flattening and pagination. |
| Integration: domain flow | No | Emulate Slack | Stateful thread read/reply, scopes, membership, and deduped inbound injection. |
| Production smoke | Yes | Real Slack | Tokens, subscriptions, connect/reconnect/ack, and one real thread read/reply. |

## Risks and guardrails

1. **Ack after volatile work loses events.** Ack only after durable idempotent acceptance, not after the full business flow.
2. **Web API retry can duplicate writes.** If Slack committed a write but the response was lost, transport retry may repeat it. Keep business operations idempotent and record Slack message IDs.
3. **Emulate is not a protocol test.** Keep a small real-Slack smoke test for Socket Mode and app configuration.
4. **Emulate fidelity changes.** Pin the dependency and re-check its Slack coverage matrix and source-confirmed thread gaps before upgrades.

## Precise decision questions surfaced

1. **Which inbound Events API event triggers the Runner?** This determines the app manifest subscription, payload validator, and whether non-triggering events are simply acked or durably recorded.
2. **What concrete durable acceptance mechanism owns `put-if-absent(event_id)`?** Select the Effect queue/workflow/store before implementation.
3. **How long must dedupe state live?** Permanent uniqueness in the work record is simplest; if pruned, retention must exceed the longest enabled Slack redelivery window plus clock skew.
4. **Is the Slack app private/internal or distributed?** Socket Mode apps cannot be listed in the public Slack Marketplace, and distribution changes `conversations.replies` rate limits. [Socket Mode distribution limit](https://docs.slack.dev/apis/events-api/using-socket-mode/)

## Recommended next step

Resolve the four questions above, then implement the two ports and the four test layers. Keep Socket Mode configuration and smoke coverage explicitly outside Emulate.
