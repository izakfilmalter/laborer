# Supported ACP runtime matrix

Issue #243 establishes one exact release-safety contract for `next`.

| Component | Supported version | Enforced by |
| --- | --- | --- |
| Node.js | `24.11.1` | `.node-version`, package engines, Sandcastle image and local tests |
| Bun | `1.3.5` | package manager pin, Sandcastle image and local tests |
| ACP wire protocol | stable v1 (`1`) | initialization validator and compatibility suite |
| `@agentclientprotocol/sdk` | `1.3.0` | exact dependency and lockfile |
| `@opencode-ai/cli` (`opencode2`) | `0.0.0-next-16573` | exact dev dependency, CLI assertion |
| `@opencode-ai/client` | `0.0.0-next-16573` | exact dependency and lockfile |
| `@slack/web-api` | `8.0.0` | exact dependency and lockfile |
| `@slack/socket-mode` | `3.0.0` | exact dependency and lockfile |
| Emulate | `0.9.0` | exact dependency and lockfile |

The final Sandcastle code-review agent owns `bun run --cwd next check` and its
evidence. It performs formatting, typechecking, all credential-free
deterministic/Emulate tests, and the pinned real OpenCode compatibility and
policy tests against its final reviewed PR head. The runner requires a clean,
committed review result but trusts the agent's verification instead of rerunning
the suite. The Sandcastle image pins the supported Node and Bun releases. GitHub
Actions intentionally does not verify `next`; the existing `current`
pull-request job remains independent.

The real suite invokes Laborer's ACP adapter and only the pinned local OpenCode
executable behind it. The adapter starts a private authenticated
`opencode2 serve` process and registers ACP-provided MCP servers with
`codemode: false`, preserving direct tool identity for Action and Memory
authorization while keeping ACP as the generic Laborer boundary. It uses an
isolated owner-only home and workspace, a loopback fake model provider with a
dummy key, and a local MCP fixture. It has no Slack or model credentials and
proves initialization capabilities, `agent_message_chunk` updates, direct MCP
permission selection, cancellation, and durable resume in a fresh process.
The pinned beta maps provider content filtering to `end_turn`. Scripted ACP
coverage retains stable refusal, `max_tokens`, and
`max_turn_requests` behavior that the pinned OpenCode 2 beta cannot deterministically emit
through this fixture.

## Deliberate upgrade procedure

1. Change `src/acp-compatibility/runtime-matrix.ts`, exact package declarations,
   `.node-version`, and package runtime fields together.
2. Regenerate `bun.lock` with the intended Bun release.
3. Run `bun run check` on the supported Node release.
4. Treat capability or stop-reason changes as protocol changes; update tests and
   this document deliberately rather than weakening the validator.
