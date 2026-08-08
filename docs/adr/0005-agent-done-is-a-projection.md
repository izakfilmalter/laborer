# Agent "done" is a projection (idle + unseen), not a lifecycle state

The legacy app's agent status collapsed "needs input", "completed", and "errored" into one `waiting_for_input` value, making notifications and UI labels wrong for two of the three meanings. We adopted herdr's model: the stored agent status is only `working | needs_input | idle | unknown`, and **done** is derived at display time as `idle` plus an unseen bit that clears when the operator views the terminal's workspace in a focused window. Errors surface as `needs_input` (a human must act either way).

Detectors (hooks, process inspection) therefore never report "done" — they only report semantic lifecycle states, and completion-acknowledgement stays a local interaction property. This keeps every adapter simple and makes "the agent finished while nobody was watching" impossible to get stuck, because it is not a state that anything has to remember to clear.

## Considered options

- **Explicit `done`/`failed` lifecycle states** — rejected: every detector would need to distinguish them reliably, and a missed clearing event leaves a stuck terminal (the exact failure mode of PRs #60/#66/#143/#148).
- **Durable status via LiveStore events** — rejected: agent status is advisory runtime state (ADR 0003); keeping it ephemeral in the terminal service avoids permanent event-compatibility burden. It is lost on service restart and simply re-detected.

## Consequences

- Do not add a `done` or `completed` value to the agent status union; add UI projections instead.
- The seen bit lives in the terminal service (shared across windows), not in any renderer.
