# ACP production cutover gate and rollback

`bun run start:slack` is the only authoritative production receiver. It uses
durable ACP Conversations, the process supervisor, native Slack stream
projection, Action/Execution MCP, interactive permissions, adoption, and
recovery. There is no alternate production receiver or runtime selector.

## Automated gate

- Require Sandcastle's runner-enforced `bun run --cwd next check` gate to pass
  for the exact reviewed PR head.
- Confirm `recovery health` reports every binding as `ready`; investigate bounded
  reason codes for setup/config incompatibility, quarantine, circuit opening,
  blocked prompts, uncertain Action/Execution outcomes, stream uncertainty, or
  outbox backlog.
- Confirm the normal receiver is the ACP composition and the diagnostic ACP
  canary is not running with production Slack credentials.

## Manual credentialed gate

This gate cannot run in Sandcastle's credential-free automated verification and
must not be reported as automated.

1. Install the manifest as a dedicated canary Slack app with Socket Mode and
   interactivity enabled; use isolated canary app/bot credentials.
2. Stop any existing canary receiver, then run `bun run start:acp-canary`.
3. In an invited isolated channel, verify an ordinary response uses one native,
   unedited stream and a follow-up resumes the same durable Conversation.
4. Request a small `create-feature`; approve any expected one-shot interaction;
   verify Action acceptance, implementation Execution, and the final ACP result
   in the owning thread.
5. Restart during a disposable scene and verify adoption/recovery plus
   `recovery health --workspace <team>` without exposed content, paths,
   arguments, tokens, or environment values.
6. Stop the canary. Stop the existing normal receiver. Start exactly one
   `bun run start:slack` receiver and repeat steps 3–5 in the production smoke
   channel.

## Rollback policy

- Never start a simultaneous same-app receiver; Socket Mode may deliver an event
  to either connection.
- There is no automatic legacy fallback after ACP accepts a turn and no dual
  publish. Old Conversation state remains read-only evidence.
- To roll back, first stop the receiver, preserve all v1–v16 runtime state, and
  deploy the last known-good ACP build. Do not delete unresolved state or
  reintroduce a non-ACP Conversation runtime.
- Resolve or explicitly abandon uncertain prompts and Action/Execution outcomes
  through the owner-only recovery API before retrying work.
