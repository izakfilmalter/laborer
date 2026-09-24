# Supported primary runtime matrix

Issue #243 establishes one exact release-safety contract for `next`.

The authoritative composition is Node-hosted `chat` + `@chat-adapter/slack`
over Socket Mode, wrapping the ACP stable-v1 boundary to the OpenCode 2
installed on the host. The Chat packages and ACP/OpenCode packages therefore move through one
supported matrix rather than describing separate production receivers.

| Component | Supported version | Enforced by |
| --- | --- | --- |
| Node.js | `24.11.1` | `.node-version`, package engines, Sandcastle image and local tests |
| Bun | `1.3.5` | package manager pin, Sandcastle image and local tests |
| ACP wire protocol | stable v1 (`1`) | initialization validator and compatibility suite |
| `@agentclientprotocol/sdk` | `1.3.0` | exact dependency and lockfile |
| OpenCode CLI (`opencode` / `opencode2`) | installed OpenCode 2 (2.x or a `0.0.0-*` preview) | `installed-opencode.ts` resolution and the ACP version check |
| `@opencode/client` | `2.0.16` | exact dependency and lockfile; the adapter's HTTP API contract |

## Installed OpenCode

Laborer runs the OpenCode 2 installed on the host rather than a bundled copy,
so the daemon uses the operator's own OpenCode configuration, providers, and
credentials. A bundled pin drifted from the operator's OpenCode: it could not
read their provider setup and silently fell back to other models.

Resolution: `LABORER_OPENCODE_COMMAND` if set, otherwise the first `opencode`
or `opencode2` on `PATH` whose `--version` is OpenCode 2. OpenCode 1 builds are
skipped. With none found, the workspace fails to start with an actionable
error. The trade-off is that OpenCode upgrades reach Laborer without review;
the typed client and adapter still target one HTTP API (`@opencode/client`,
kept at the installed OpenCode's release), so an incompatible
OpenCode release surfaces as ACP initialization or prompt failures, which the
real compatibility suite (`test:process-backed`) detects against the installed
build.
| `@slack/web-api` | `8.0.0` | exact dependency and lockfile |
| `chat` | `4.37.0` | exact dependency and lockfile |
| `@chat-adapter/slack` | `4.37.0` | exact dependency and lockfile |

The final Sandcastle code-review agent owns `bun run --cwd apps/bot check` and its
evidence. It performs formatting, typechecking, all credential-free
deterministic offline tests, and the pinned real OpenCode compatibility and
policy tests against its final reviewed PR head. The runner requires a clean,
committed review result but trusts the agent's verification instead of rerunning
the suite. The Sandcastle image pins the supported Node and Bun releases. GitHub
Actions intentionally does not verify `next`; the existing `current`
pull-request job remains independent.

The real suite invokes Laborer's ACP adapter and the installed OpenCode 2
executable behind it. The adapter starts a private authenticated
`opencode2 serve` process and registers ACP-provided MCP servers with
`codemode: false`, preserving direct tool identity for Action and Memory
authorization while keeping ACP as the generic Laborer boundary. It uses an
isolated owner-only home and workspace, a loopback fake model provider with a
dummy key, and a local MCP fixture. It has no Slack or model credentials and
proves initialization capabilities, `agent_message_chunk` updates, direct MCP
permission selection, cancellation, and durable resume in a fresh process.
OpenCode 2.0.16 maps provider content filtering to `refusal` and
`finish_reason: length` to `max_tokens` (the earlier preview reported both as
`end_turn`). Scripted ACP coverage retains `max_turn_requests`, which OpenCode
cannot deterministically emit through this fixture.

## Deliberate upgrade procedure

1. Change `src/acp-compatibility/runtime-matrix.ts`, exact package declarations
   (OpenCode itself follows the host installation),
   `.node-version`, and package runtime fields together.
2. Regenerate `bun.lock` with the intended Bun release.
3. Run `bun run check` on the supported Node release.
4. Treat capability or stop-reason changes as protocol changes; update tests and
   this document deliberately rather than weakening the validator.
