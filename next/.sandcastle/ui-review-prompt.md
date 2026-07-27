# TASK

Review and improve UI design quality for issue {{TASK_ID}}: {{ISSUE_TITLE}} on branch `{{BRANCH}}` before publication.

UI brief: {{UI_BRIEF}}

{{VERIFICATION_POLICY}}

Start with `git diff --stat {{TARGET_BRANCH}}...{{BRANCH}}`, `git diff --name-only {{TARGET_BRANCH}}...{{BRANCH}}`, and `git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`. Inspect focused UI hunks rather than dumping a large diff.

Focus on product design, accessibility, hierarchy, states, affordances, interaction quality, and fit with nearby Laborer surfaces. The all-around reviewer handles architecture, durability, and broad code quality after you.

Make scoped improvements directly, run the narrowest relevant check, and commit with a concise `SANDCASTLE:` message. If the interface is already strong, make no commit. Do not invoke review workflows or subagents, push, merge, poll CI, or install unchanged dependencies.

When complete, output `<promise>COMPLETE</promise>`.
