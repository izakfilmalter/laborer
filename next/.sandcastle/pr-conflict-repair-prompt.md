# TASK

Resolve merge conflicts for issue {{TASK_ID}}: {{ISSUE_TITLE}} on branch `{{BRANCH}}`.

PR: {{PR_URL}}
Base branch: {{BASE_BRANCH}}

{{VERIFICATION_POLICY}}

Fetch `origin/{{BASE_BRANCH}}`, merge it into `{{BRANCH}}`, and resolve conflicts while preserving both the issue's intent and current base behavior. Run checks targeted to affected files and commit the resolution. The dedicated code-review phase owns the final comprehensive check.

Do not force-push, bypass checks, merge the PR locally, poll CI, invoke review workflows or subagents, or install unchanged dependencies. If the issue is obsolete or unsafe, report the blocker in your final output and stop; the sandbox token is intentionally read-only.

When complete, output `<promise>COMPLETE</promise>`.
