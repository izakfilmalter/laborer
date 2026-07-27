# Supported ACP runtime matrix

Issue #243 establishes one exact release-safety contract for `next`.

| Component | Supported version | Enforced by |
| --- | --- | --- |
| Node.js | `24.11.1` | `.node-version`, package engines, Next CI |
| Bun | `1.3.5` | package manager pin, Next CI |
| ACP wire protocol | stable v1 (`1`) | initialization validator and compatibility suite |
| `@agentclientprotocol/sdk` | `1.3.0` | exact dependency and lockfile |
| `opencode-ai` CLI | `1.18.4` | exact dev dependency, CLI assertion |
| `@opencode-ai/sdk` | `1.18.4` | exact dependency and lockfile |
| `@slack/web-api` | `8.0.0` | exact dependency and lockfile |
| `@slack/socket-mode` | `3.0.0` | exact dependency and lockfile |
| Emulate | `0.9.0` | exact dependency and lockfile |

The complete GitHub Actions **Next / CI** job is the sole green production
cutover signal. It performs a frozen install, exact runtime verification,
formatting, typechecking, all credential-free deterministic/Emulate tests, and
the pinned real OpenCode compatibility and policy tests. The existing `current`
pull-request job remains independent.

The real suite invokes only the pinned local OpenCode executable. It uses an
isolated owner-only home and workspace, a loopback fake model provider with a
dummy key, and a local MCP fixture. It has no Slack or model credentials and
proves initialization capabilities, streaming, MCP permission selection,
cancellation, refusal, and durable resume in a fresh process. Scripted ACP
coverage retains stable `max_tokens` and `max_turn_requests` behavior that
OpenCode 1.18.4 cannot deterministically emit through this fixture.

## Deliberate upgrade procedure

1. Change `src/acp-compatibility/runtime-matrix.ts`, exact package declarations,
   `.node-version`, and package runtime fields together.
2. Regenerate `bun.lock` with the intended Bun release.
3. Run `bun run check` on the supported Node release.
4. Treat capability or stop-reason changes as protocol changes; update tests and
   this document deliberately rather than weakening the validator.
