# TASK

Fix failing GitHub checks for issue {{TASK_ID}}: {{ISSUE_TITLE}} on branch `{{BRANCH}}`.

PR: {{PR_URL}}

```json
{{FAILED_CHECKS_JSON}}
```

{{VERIFICATION_POLICY}}

Inspect the failed check and logs with `gh`, reproduce with the narrowest relevant Bun command, fix the root cause without weakening checks, verify it, and commit. Keep the change scoped to the issue.

Do not force-push, push, merge, poll the replacement CI run, invoke review workflows or subagents, or install unchanged dependencies. The runner owns publication and polling.

When complete, output `<promise>COMPLETE</promise>`.
