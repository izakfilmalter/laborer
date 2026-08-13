# NATIVE RUNNABLE ISSUES

The host runner has already fetched and validated GitHub's native parent,
sub-issue, and blocking relationships. Parent specifications and blocked leaves
have already been excluded. Every entry below is safe to run now:

<candidates-json>

{{CANDIDATES_JSON}}

</candidates-json>

# TASK

Return one classification for every candidate. Preserve each candidate's exact
`id`, `title`, and `branch`; do not add, remove, reorder, merge, or replace work.
Dependency selection and branch ownership are host-controlled.

Set `needsUi: true` only when a dedicated design pass would materially improve
a user-facing Slack surface, companion interface, layout, interaction, or visual
hierarchy. For mixed work, the all-around builder handles architecture and
plumbing first and the UI builder follows on the same branch. Include a concise
`uiBrief` when true; omit it when false.

Laborer is Slack-native and the bot workspace (`apps/bot`; `apps/bot/` on
pre-flatten branches) is primary. Do not classify Slack adapters,
Block Kit plumbing, backend behavior, durability work, or protocol work as UI
merely because people eventually observe it in Slack.

# OUTPUT

Emit only a JSON object wrapped in `<plan>` tags:

<plan>
{"issues":[{"id":"42","title":"Example","branch":"sandcastle/issue-42","needsUi":false}]}
</plan>
