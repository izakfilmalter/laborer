# TASK

Verify and fix issue {{TASK_ID}}: {{ISSUE_TITLE}} on branch `{{BRANCH}}`.

NEEDS_UI: {{NEEDS_UI}}

# RUNNER GATE CONTEXT

{{GATE_CONTEXT}}

# PROCESS

1. Inspect the focused branch diff and relevant tests.
2. Run targeted checks while diagnosing.
3. Run `bun run --cwd next format:fix`, inspect and commit any formatting changes, then run `bun run --cwd next check`.
4. Fix every scoped formatting, type, unit, integration, compatibility, and policy failure. Repeat the gate until it passes.
5. Add deterministic regression coverage for missing behavior. Never use real Slack, OpenCode sessions, or model providers in automated tests.

{{VERIFICATION_POLICY}}

Do not run live Slack or ACP canaries. Do not invoke review workflows or subagents, push, merge, poll CI, or install unchanged dependencies.

Commit fixes with a concise `SANDCASTLE:` message. When the full gate passes and the issue is complete, output `<promise>COMPLETE</promise>`.
