# TASK

Verify and fix issue {{TASK_ID}}: {{ISSUE_TITLE}} on branch `{{BRANCH}}`.

NEEDS_UI: {{NEEDS_UI}}

# RUNNER GATE CONTEXT

{{GATE_CONTEXT}}

# PROCESS

1. Inspect the focused branch diff and relevant tests.
2. Run targeted checks while diagnosing.
3. Fix every scoped formatting, type, unit, integration, compatibility, and policy failure identified by the runner. Use the narrowest checks that reproduce those failures.
4. Run `bun run --cwd next format:fix`, then inspect and commit any formatting changes. Do not run `bun run --cwd next check`; the runner will repeat that comprehensive gate once.
5. Add deterministic regression coverage for missing behavior. Never use real Slack, OpenCode sessions, or model providers in automated tests.
6. Keep repairs within the issue's behavioral scope. If a failure is caused by the sandbox, process isolation, leaked processes, unavailable infrastructure, or an unrelated flaky test, do not alter product code, global test concurrency, or unrelated assertions to make the gate pass. Report the infrastructure blocker without a completion promise.

{{VERIFICATION_POLICY}}

Do not run live Slack or ACP canaries. Do not invoke review workflows or subagents, push, merge, poll CI, or install unchanged dependencies.

Commit fixes with a concise `SANDCASTLE:` message. When the scoped repair is complete, output `<promise>COMPLETE</promise>`.
