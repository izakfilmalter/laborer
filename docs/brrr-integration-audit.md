# brrr Integration Audit

An inventory of what brrr can do, what Laborer already uses, and what we could leverage further.

## What Laborer Already Uses

| brrr Feature | How Laborer Uses It |
|---|---|
| `brrr build --once` | `brrr.startLoop` RPC — spawns in a terminal pane via workspace button |
| `brrr review <PR>` | `brrr.review` RPC — button on workspace card, auto-detects PR number |
| `brrr fix <PR>` | `brrr.fix` RPC — button on workspace card, auto-detects PR number |
| `.brrr/config.toml` (Linear section) | `LinearTaskImporter` reads `[linear]` to import tasks |
| `brrrConfig` path | Configurable per-project in `laborer.json` and project settings UI |

All three commands are fire-and-forget into a terminal pane. The output is raw text — no structured data is extracted.

---

## What brrr Can Do That We Are Not Using

### 1. Continuous / Multi-iteration Loop

brrr supports `--continuous` and `--max-iterations N`. Laborer only calls `--once`. A "keep going" toggle could let brrr pick up the next task automatically after finishing one, with a configurable poll interval, instead of requiring the user to click "Start" each time.

### 2. Structured Progress Events

brrr emits structured progress through pipeline phases: **Choose → Implement → Review → ReviewAggregate → Fix**. It has a `ProgressReporter` trait for this. If we parsed the stream-json output or brrr exposed structured events, the UI could show a pipeline visualization per workspace — which phase it is in, time per phase, success/failure per step.

### 3. Per-Phase Review Configuration

brrr's review system runs 3+ review phases in parallel (correctness, security, hygiene), each independently configurable with:
- AI model
- Effort level
- Timeout
- Runner variant

Laborer doesn't expose any of this. Project settings could let users configure review depth and phases.

### 4. Review Verdicts and Findings

brrr produces structured review output:
- **Verdict:** approved / needs_fix
- **Findings:** severity (critical/warning/info), category, file position, description
- **Inline PR comments** mapped to diff positions

Laborer could render these in a findings panel rather than showing raw terminal output. This would give users a code-review-like experience inside Laborer.

### 5. Fix Dependency Ordering and Batch Scheduling

brrr's fix system:
- Orders findings by dependency graph (Tarjan's SCC for cycle detection)
- Batches by severity (criticals run solo, warnings in groups of 3)
- Handles push conflicts with rebase + retry (up to 3 attempts)
- Agent-assisted merge conflict resolution
- Retries failed criticals once automatically

Laborer has no visibility into the fix queue. A fix progress panel could show dependency edges, batch state, and retry status.

### 6. `brrr init` — Guided Task Source Setup

brrr has an `init` command that interactively sets up Linear integration (team discovery, label creation). Laborer could offer a guided setup wizard in the project settings UI instead of requiring manual `.brrr/config.toml` editing.

### 7. `brrr prd` — AI-Assisted PRD Drafting

brrr has a dedicated `prd` command that launches an AI agent session for writing PRDs. Laborer already has a rich PRD editor (Platejs), but could add an "AI Draft" button that runs `brrr prd` and feeds the result into the editor.

### 8. Agent Timeout and Session Resume

brrr tracks agent session IDs and can resume timed-out sessions rather than starting over (up to `agent_timeout_retries` attempts). Laborer doesn't surface this. A "Resume" action could avoid losing context on long-running agent tasks.

### 9. Prompt Overrides

brrr has 8 default prompt templates with `{{variable}}` substitution and supports per-project overrides by dropping custom `.md` files in an override directory. Templates cover:
- `choose-issue.md` — task selection
- `implement-issue.md` — implementation
- `correctness-review-issue.md`, `security-review-issue.md`, `hygiene-review-issue.md` — review phases
- `review-aggregate-issue.md` — aggregation
- `fix-issue.md` — fix agent
- `prd.md` — PRD writing

Laborer could let users view and customize these prompts through the UI.

### 10. Auto Task Selection (Choose Agent)

brrr has a "choose" phase where an AI agent reads all eligible tasks and picks the best one, writing its choice to `.brrr/task.toml`. Laborer only supports manual task selection. An "Auto-pick next task" option could wire up brrr's choose agent.

### 11. Existing PR Deduplication

brrr checks for existing PRs before creating new ones by scanning open PR bodies for `#N` references. Starting a loop in Laborer for a task that already has an open PR could create a duplicate.

### 12. JSON Correction / Retry for Review Output

When an AI agent returns malformed JSON for review findings, brrr resumes the session with a correction prompt showing the expected schema (up to 2 retries). Review failures in Laborer may go unretried.

### 13. `.brrr/worktree-setup.sh` Convention

brrr auto-executes `.brrr/worktree-setup.sh` after creating a worktree (with safety validation — no absolute paths, no parent traversal). Laborer has its own `setupScripts` config but doesn't honor brrr's convention. Could fall back to it.

---

## What Laborer Has That brrr Does Not

| Laborer Feature | Notes |
|---|---|
| Multi-workspace visual management (tmux-style panels) | brrr is a single-task CLI |
| Live diff viewer per workspace | brrr has no UI |
| PTY terminal emulation with WebGL | brrr outputs to stderr |
| Desktop app (Electron, tray, multi-window) | CLI only |
| LiveStore event-sourced state sync | No persistence beyond files |
| File watching + event-driven refresh | No file watching |
| Docker container orchestration per workspace | No containerization |
| MCP server for agent tool integration | No MCP |
| Port allocation per workspace | Single process |
| PR status polling + badges | Creates PRs but doesn't track state |
| Manual task creation | Only imports from external sources |
| Rich PRD editor (Platejs) | Text-only PRD via agent |

---

## Highest-Impact Opportunities (Ranked)

1. **Structured pipeline visibility** — Parse brrr's progress/phase transitions to show a status pipeline per workspace instead of raw terminal output.
2. **Review findings panel** — Render structured review findings (severity, category, file:line) in a dedicated UI.
3. **Continuous loop mode** — "Keep running" toggle so brrr auto-picks the next task.
4. **Auto-pick next task** — Wire up brrr's choose agent for hands-free task selection.
5. **`brrr prd` integration** — "AI Draft" button in the PRD editor.
6. **`brrr init` flow** — Guided Linear/GitHub setup wizard in project settings.
