# TASK

Review and improve the branch for issue {{TASK_ID}}: {{ISSUE_TITLE}} on `{{BRANCH}}` before publication.

{{VERIFICATION_POLICY}}

Start with:

- `git diff --stat {{TARGET_BRANCH}}...{{BRANCH}}`
- `git diff --name-only {{TARGET_BRANCH}}...{{BRANCH}}`
- `git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

Then inspect focused files and hunks. Verify the issue/spec, `AGENTS.md`, `next/AGENTS.md`, `CONTEXT.md`, applicable ADRs, and `next/.sandcastle/CODING_STANDARDS.md`.

Review correctness, exact scope, tests, failure behavior, durable ordering, replay safety, resource cleanup, bounded operations, untrusted boundaries, credential safety, architectural ownership, Effect usage, and maintainability. Look for unsafe casts, hidden side effects, accidental public output, broad rewrites, and tests that depend on live services.

Make improvements directly on the branch. Run the narrowest relevant check if code changes, and commit refinements with a concise `SANDCASTLE:` message. If no change is needed, make no commit. Do not run `bun run --cwd next check`; the runner executes that comprehensive gate once after this review. Do not invoke review skills or subagents, push, merge, poll CI, or install unchanged dependencies.

When complete, output `<promise>COMPLETE</promise>`.
