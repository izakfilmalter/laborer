# TASK

Review and improve the branch for issue {{TASK_ID}}: {{ISSUE_TITLE}} on `{{BRANCH}}` before publication.

{{VERIFICATION_POLICY}}

Start with:

- `git diff --stat {{TARGET_BRANCH}}...{{BRANCH}}`
- `git diff --name-only {{TARGET_BRANCH}}...{{BRANCH}}`
- `git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

Then inspect focused files and hunks. Verify the issue/spec, `AGENTS.md`, the nearest implementation `AGENTS.md`, `CONTEXT.md`, applicable ADRs, and `.sandcastle/CODING_STANDARDS.md`.

Review correctness, exact scope, tests, failure behavior, durable ordering, replay safety, resource cleanup, bounded operations, untrusted boundaries, credential safety, architectural ownership, Effect usage, and maintainability. Look for unsafe casts, hidden side effects, accidental public output, broad rewrites, and tests that depend on live services.

Make improvements directly on the branch and commit refinements with a concise `SANDCASTLE:` message. If no change is needed, make no commit. After improvements, format and run the comprehensive check for each affected workspace using the `format:fix` and `check` scripts declared in that tree's `package.json` (for example `bun run --cwd apps/bot format:fix` then `bun run --cwd apps/bot check`, or the root scripts once the merged root manifest provides them; on pre-flatten branches that still have `current/` and `next/`, use those directories instead). Run every affected workspace for cross-workspace changes. Commit formatting changes before checks. Fix failures caused by this issue and rerun relevant checks. Any code change after a comprehensive check must be committed and followed by the affected check again; complete only from the final checked HEAD. If a remaining failure on that final HEAD is demonstrably unrelated, flaky, or infrastructure-caused, do not alter unrelated code to make it pass; report the exact evidence and use the scoped checks to decide whether review is complete. The runner will trust your verification and will not rerun checks. Do not invoke review skills or subagents, push, merge, poll CI, or install unchanged dependencies.

When complete, output `<promise>COMPLETE</promise>`.
