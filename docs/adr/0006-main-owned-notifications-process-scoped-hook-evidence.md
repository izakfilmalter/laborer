# Main-owned notification coordination; process-scoped hook evidence; detection failure is not evidence

Agent-attention notifications were detected and sent independently by every renderer window, hook status overrode process detection forever, and a failed `ps` sample looked identical to "no agent running" — together producing duplicate, stuck, and false notifications (repaired repeatedly in PRs #60, #66, #143, #148). We decided:

1. **Electron main owns notification coordination.** One coordinator in the main process performs per-terminal transition detection, debounce (~1s pending per terminal, replaced by newer transitions, revalidated before delivery), app-wide focus suppression, and click routing that can open a workspace not currently visible in any window. Renderers only display in-app state.
2. **Hook evidence is process-scoped.** A hook-reported status is authoritative only while the hooked agent process remains in the terminal's process chain; when the agent exits or is replaced, the override clears back to process detection. Status carries `source` and `changedAt` so staleness is diagnosable. No arbitrary expiry timer.
3. **Detection failure never synthesizes a transition.** A `ps` error or timeout preserves the last known status (marked stale after sustained failure) rather than reading as "agent gone"; state transitions require successful detection, and downward ps-derived transitions require consecutive confirming samples. Per ADR 0003, staleness is advisory — nothing is ever terminated because of it.

## Consequences

- Notification policy (dedupe, focus, triggers) must not be reintroduced into renderer hooks; renderers report visibility/focus facts to main.
- Any new detector source must state its authority scope and provide provenance; "latest write wins forever" is not an acceptable arbitration rule.
