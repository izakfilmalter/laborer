# Coding Standards

The reviewer agents load this file during Sandcastle review.

## Scope and architecture

- Default product work to `next/`; change `current/` only when an issue explicitly concerns the legacy app.
- Preserve the ownership boundaries and canonical language in `AGENTS.md`, `next/AGENTS.md`, and `CONTEXT.md`.
- The Runner owns ingestion, durable turn ordering, process supervision, and delivery. Work handlers own workflow meaning, tools, agent choice, continuation state, and repository policy.
- Keep Slack, ACP, and OpenCode details in adapters or configured handlers rather than the generic core.
- Keep throwaway work inside its named prototype unless the issue explicitly promotes it.
- Prefer narrow contracts, explicit resource lifecycles, bounded operations, and fail-closed behavior at untrusted or persisted boundaries.

## TypeScript and Effect

- Use Bun commands and existing repository patterns.
- Avoid `any`, unsafe casts, broad rewrites, and speculative abstractions.
- Before changing Effect code, follow `next/AGENTS.md`: inspect the installed Effect 4 beta APIs and existing usage rather than assuming stable Effect APIs.
- Use Schema at untrusted and persisted boundaries, schema-tagged expected errors, narrow services, Layers, and scoped resource lifecycles.

## Security and durability

- Never expose Slack credentials, raw child output, diagnostics, local paths, or private agent activity in public replies.
- Do not copy `next/.env.local` into Sandcastle worktrees or agent environments.
- Preserve stable identities, durable ordering, replay idempotency, atomic persistence, and bounded shutdown behavior.
- Automated tests must remain deterministic and offline. Do not run live Slack or ACP canaries unless the issue explicitly requires a manual smoke test and credentials are available.

## Verification

- Run targeted checks while iterating.
- From the repository root, format with `bun run --cwd next format:fix` and run the full next gate with `bun run --cwd next check`.
- Add deterministic regression coverage for behavior changes. Use fakes and Emulate instead of live services.

## Sandcastle workflow

- The host runner fetches GitHub's native parent, sub-issue, and blocking relationships and fails closed when that graph is malformed or unavailable. Agents do not infer scheduling from issue prose.
- Parent specifications are orchestration containers, never executable tasks. Sandcastle selects at most the first open, unblocked descendant leaf per root and chooses no fallback when every leaf is blocked.
- Descendants of one specification accumulate on `sandcastle/spec-<root-id>` and one shared draft PR. Exact PR-body markers record implemented-but-unmerged leaves so later iterations can continue safely.
- Descendant issues remain open while their shared PR is unmerged. After the reviewed PR merges, the runner closes descendants from the leaves upward and closes the root last.
- Agents commit but never push, merge, poll CI, or invoke nested review workflows. The runner owns those operations.
- The runner refreshes its base and reads prompts through its detached `.sandcastle/base` worktree so concurrent Git work cannot redirect integration onto the operator's checkout.
- Builders and UI agents use targeted checks while iterating. The final code-review agent runs `bun run --cwd next check`, distinguishes scoped failures from unrelated infrastructure or flakes, and reports its evidence. The runner trusts that review and does not rerun checks.
- PRs use `Closes #<issue>` and preserve GitHub as the integration surface.
- Failed checks are repaired on the same branch and PR.
