# PRD: MCP Server & PRD-Driven Task Workflow

## Problem Statement

Creating and managing tasks in Laborer requires manual effort — users type issue titles one at a time through a form, or rely on the `rlph prd` CLI which watches terminal output to scrape issue references. Neither approach leverages the AI agent workflow that developers already use. There is no structured way to go from a product idea to a set of issues to executing work on those issues. PRDs exist only as static markdown files in the `docs/` directory with no connection to the task system, and there is no way for AI agents (Opencode, Claude Code, Codex) to directly create or manage plans and issues within Laborer.

## Solution

Introduce a new `@laborer/mcp` package that runs a Model Context Protocol (MCP) server over stdio. This server exposes tools that allow AI agents to create PRDs, break them into issues, and read/update plans — all persisted through Laborer's existing LiveStore infrastructure. PRDs are stored as markdown files on disk (configurable path, default `~/.config/laborer/${projectName}/prds/`), with associated issues stored in a companion markdown file per PRD.

The MCP server auto-registers itself with Opencode, Claude Code, and Codex on Laborer server startup, so any AI agent session immediately has access to Laborer's planning tools.

The UI gains a new "Plans" sub-section per project in the sidebar, showing all PRDs. Clicking a plan opens a Plate.js markdown editor alongside its issues list. A "Create Workspace" button on a plan creates a single workspace for that plan. Within that workspace, the user can kick off rlph to work through issues. The MCP provides tools for rlph to read the full PRD and all remaining issues, so it has complete context for the work.

Manual task creation (CreateTaskForm) and the rlph-based PRD writing flow (WritePrdForm, `rlph.writePRD` RPC, PrdTaskImporter) are removed. Linear and GitHub imports remain.

## User Stories

1. As a developer, I want to chat with an AI agent and have it create a PRD directly in Laborer, so that I don't need to manually write planning documents.
2. As a developer, I want an AI agent to break my PRD into individual issues, so that I get a structured task list without manual effort.
3. As a developer, I want PRDs saved as markdown files on disk, so that I can read and edit them with any tool.
4. As a developer, I want PRD files stored in a configurable directory (default `~/.config/laborer/${projectName}/prds/`), so that they don't pollute my repository.
5. As a developer, I want to customize the PRD storage path in `laborer.json`, so that I can place plans wherever makes sense for my workflow.
6. As a developer, I want each PRD to have an associated issues file (`PRD-<name>-issues.md`), so that the plan and its breakdown are kept together.
7. As a developer, I want the MCP server to auto-register with Opencode, Claude Code, and Codex when Laborer starts, so that I don't need to manually configure each AI tool.
8. As a developer, I want the MCP server to discover which project I'm working in based on my current working directory, so that I don't need to specify the project on every tool call.
9. As a developer, I want to see a "Plans" section under each project in the sidebar, so that I can browse all PRDs for a project.
10. As a developer, I want to click a plan to open it in a markdown editor, so that I can read and refine the PRD within Laborer.
11. As a developer, I want to see a plan's issues alongside its markdown content, so that I can track progress on the breakdown.
12. As a developer, I want a "Create Workspace" button on a plan, so that I can spin up a single workspace to work on that plan's issues.
13. As a developer, I want to kick off rlph in a plan workspace, so that the AI agent can work through the plan's issues.
14. As a developer, I want rlph to have access to the full PRD and all remaining issues via MCP tools, so that it has complete context for the work it needs to do.
15. As a developer, I want the AI agent to create issues one at a time via individual MCP tool calls, so that the agent controls sequencing and can reference earlier issues.
16. As a developer, I want the AI agent to be able to read, create, and update both PRDs and issues, so that iterative refinement is possible.
17. As a developer, I want the MCP server to connect to the main Laborer server via RPC, so that all data flows through LiveStore and the UI stays in sync.
18. As a developer, I want the MCP server to run as a separate process with stdio transport, so that it follows the standard MCP integration pattern for AI tools.
19. As a developer, I want issue status changes in the UI to be reflected when the AI agent queries remaining issues, so that the agent always has current state.
20. As a developer, I want the plan workspace to show a slimmed-down task list scoped to that plan's issues, so that I can track progress without noise from other tasks.
21. As a developer, I want the sidebar plan list to show the plan's status (how many issues are pending/completed), so that I get a quick progress overview.
22. As a developer, I want Linear and GitHub task imports to continue working alongside the new PRD-driven flow, so that I can still pull in external issues when needed.
23. As a developer, I want the manual task creation form removed, so that the UI is simplified and the PRD-driven workflow is the primary path.
24. As a developer, I want the old WritePrdForm and rlph.writePRD flow removed, so that there is a single clear way to create plans.
25. As a developer, I want the MCP auto-registration to be idempotent, so that it doesn't break my existing AI tool configurations on every server restart.
26. As a developer, I want the MCP server to expose a `list_remaining_issues` tool, so that rlph can efficiently query only the work left to do.
27. As a developer, I want the Plate.js editor to support basic markdown features (headings, lists, bold, italic, code blocks, links), so that PRDs render correctly.

## 'Polishing' Requirements

1. Verify the Plans sub-section in the sidebar has consistent visual hierarchy with Workspaces and Tasks sections — indentation, font weight, and spacing should follow the same pattern.
2. Ensure the Plate.js editor loads without layout shift or flash of unstyled content.
3. Verify the plan detail view (editor + issues list) has a responsive layout that works at various sidebar widths.
4. Ensure issue status indicators (pending, in_progress, completed, cancelled) use the same visual language (colors, icons) as the existing task list.
5. Verify the "Create Workspace" button on a plan is disabled with a tooltip when a workspace already exists for that plan.
6. Ensure the MCP auto-registration does not overwrite user-added MCP servers in their AI tool configs — only the Laborer entry should be managed.
7. Verify that the MCP server handles concurrent tool calls gracefully (multiple AI agents or rapid sequential calls).
8. Ensure error states in the plan editor (failed to save, file not found) show clear, actionable messages.
9. Verify keyboard navigation works for the Plans section: Tab through plan items, Enter to open, keyboard shortcuts for common actions.
10. Ensure the plan workspace's slimmed-down task list updates in real-time as issue statuses change (via LiveStore reactivity).
11. Verify that creating a workspace from a plan pre-fills sensible defaults (branch name derived from plan name, project already set).
12. Ensure the Plate.js editor preserves markdown formatting on round-trip (no content loss when editing and saving).

## Implementation Decisions

### `@laborer/mcp` — New Package

A new package in `packages/mcp/` that builds a standalone stdio MCP server using `McpServer` from `@effect/ai`. Runs as a separate Bun process.

**MCP Tools:**

- `create_prd` — Creates a new PRD markdown file and registers it in LiveStore. Accepts `title` and `content` (markdown). Returns the PRD ID and file path.
- `read_prd` — Reads a PRD's markdown content by ID or title. Returns the full markdown.
- `update_prd` — Overwrites a PRD's markdown content. Accepts PRD ID and new content.
- `list_prds` — Lists all PRDs for the current project. Returns titles, IDs, and issue count summaries.
- `create_issue` — Creates a single issue linked to a PRD. Accepts PRD ID, title, and the full issue body (markdown with acceptance criteria, blockers, user stories). Writes to the PRD's issues file and creates a task in LiveStore with source `"prd"`.
- `read_issues` — Reads all issues for a PRD. Returns the full issues markdown.
- `update_issue` — Updates an issue's content or status. Accepts issue ID and updated fields.
- `list_remaining_issues` — Returns only pending and in-progress issues for a PRD, with their full details. This is what rlph calls to know what work remains.

**Project Discovery:**

The MCP server discovers the current project by matching the AI agent's working directory (passed as context or inferred from the process cwd) against registered projects in LiveStore. It walks up from cwd looking for a matching `repoPath`.

**Server Connection:**

The MCP server connects to `@laborer/server` via the existing RPC protocol (`LaborerRpcs`) over HTTP. New RPC endpoints are added for PRD operations.

### PRD Storage Service (in `@laborer/server`)

A new `PrdStorageService` Effect tagged service that manages PRD and issue files on disk.

**File Layout:**

```
~/.config/laborer/<projectName>/prds/
  PRD-<slug>.md              # PRD content
  PRD-<slug>-issues.md       # Issues for this PRD
```

The base path is configurable via a new `prdsDir` field in `laborer.json`. If not set, defaults to `<worktreeDir>/prds/` (which itself defaults to `~/.config/laborer/<projectName>/prds/`).

**RPC Endpoints (added to LaborerRpcs):**

- `prd.create` — Creates PRD file + LiveStore record
- `prd.read` — Reads PRD markdown from disk
- `prd.update` — Updates PRD file on disk
- `prd.list` — Lists PRDs from LiveStore for a project
- `prd.remove` — Removes PRD file and LiveStore record
- `prd.createIssue` — Appends issue to PRD's issues file + creates task in LiveStore
- `prd.readIssues` — Reads issues file from disk
- `prd.updateIssue` — Updates issue content in the issues file
- `prd.listRemainingIssues` — Queries LiveStore for pending/in-progress tasks with source `"prd"` for a given PRD

### LiveStore Schema Changes (in `@laborer/shared`)

**New `prds` table:**

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | Branded `PrdId` |
| `projectId` | text | FK to projects |
| `title` | text | Human-readable name |
| `slug` | text | URL/file-safe version of title |
| `filePath` | text | Absolute path to PRD markdown file |
| `status` | text | `"draft"`, `"active"`, `"completed"` |
| `createdAt` | text (ISO) | Creation timestamp |

**New events:** `prdCreated`, `prdUpdated`, `prdStatusChanged`, `prdRemoved`

**Tasks table modification:** Add nullable `prdId` column to the existing `tasks` table. Tasks with source `"prd"` will have this set, linking them to a specific PRD. Existing tasks are unaffected (null `prdId`).

### MCP Auto-Registration (in `@laborer/server`)

On server startup, after LiveStore is initialized, an `McpRegistrar` service writes the MCP server configuration to the config files for Opencode, Claude Code, and Codex.

**Config locations:**

- **Opencode:** `~/.config/opencode/config.json` — adds entry to `mcpServers` object
- **Claude Code:** `~/.claude/claude_code_config.json` (or the appropriate Claude Code config) — adds entry to `mcpServers`
- **Codex:** `~/.codex/config.json` (or the appropriate Codex config) — adds entry to `mcpServers`

**Registration entry:**

```json
{
  "laborer": {
    "command": "bun",
    "args": ["run", "<path-to-mcp-package>/src/index.ts"],
    "type": "stdio"
  }
}
```

The registrar reads the existing config, merges in the Laborer MCP entry (only if not already present or if the command path has changed), and writes it back. It never removes or modifies other MCP server entries.

### Plans UI (in `apps/web`)

**Sidebar Changes:**

Each `ProjectGroup` gains a collapsible "Plans" sub-section between Workspaces and Tasks. Each plan item shows:

- Plan title
- Issue progress indicator (e.g., "3/7 done")
- Click to open plan detail view

**Plan Detail View:**

A new route/panel that shows:

- Plate.js markdown editor (left/top) with the PRD content — basic markdown features only (headings, lists, bold, italic, code blocks, links, tables)
- Issues list (right/bottom) showing all issues for this PRD with status indicators
- "Create Workspace" button that creates a single workspace linked to the plan
- Issue status toggles (same UX as current task status)

**Plate.js Integration:**

Minimal Plate setup using `@udecode/plate` with markdown serialization/deserialization. Plugins: paragraph, heading, list, bold, italic, code, code block, link, blockquote, table. No AI features.

### Removals

- `CreateTaskForm` component and its usage in the sidebar
- `WritePrdForm` component
- `rlph.writePRD` RPC endpoint and handler
- `PrdTaskImporter` service (the terminal output scraping logic)
- `TaskSourcePicker` loses the "Manual" tab (only Linear, GitHub, and PRD sources remain)

## Testing Decisions

Tests should verify external behavior — inputs and outputs — not implementation details. Mock the filesystem and LiveStore where needed, and test through the public API of each module.

### Modules to test:

**`@laborer/mcp` tools** — Test each MCP tool handler in isolation. Verify that `create_prd` produces the correct RPC call and returns expected results. Verify `list_remaining_issues` filters correctly by status. Verify project discovery logic correctly matches cwd to registered projects. Test error cases (unknown project, missing PRD, invalid input).

**PRD Storage Service** — Test file I/O operations: creating PRD files, reading them back, updating content, appending issues to the issues file. Test the slug generation from titles. Test that the configurable `prdsDir` path is respected. Test round-trip: write markdown, read it back, verify no content loss.

**MCP Auto-Registration** — Test config file reading, merging, and writing. Verify idempotency (running twice doesn't duplicate entries). Verify existing user config entries are preserved. Test each target config format (Opencode, Claude Code, Codex).

**PRD LiveStore schema** — Test that new events (`prdCreated`, `prdUpdated`, etc.) produce correct table state. Test that the `prdId` column on tasks correctly links issues to PRDs. Test queries for remaining issues (filtering by status and prdId).

**Plans UI components** — Test `PlanList` renders plan items with correct titles and progress indicators. Test plan detail view renders editor and issues list. Test "Create Workspace" button state (enabled/disabled based on existing workspace). Test issue status updates propagate correctly.

**Prior art:** The existing test patterns in the codebase (Effect service tests, LiveStore schema tests) should be followed. The `ConfigService` tests in particular demonstrate how to test file I/O with the Effect pattern.

## Out of Scope

- **Plate.js AI features** — No AI-powered editing within the markdown editor. AI interaction happens through the external MCP tools.
- **Multi-workspace per PRD** — A plan creates a single workspace. If the user wants multiple workspaces, they create them manually.
- **Issue dependency resolution** — The MCP provides all remaining issues to rlph, but does not enforce or automate blocker resolution. Rlph decides what to work on.
- **PRD versioning or history** — PRDs are plain files. Version control is handled by git if the user chooses to store them in a repo.
- **Collaborative editing** — The Plate.js editor is single-user. No real-time collaboration features.
- **Linear/GitHub import changes** — The existing Linear and GitHub task importers remain unchanged.
- **PRD templates** — No built-in templates for PRDs. The AI agent uses the write-a-prd skill's template via its own configuration.
- **Issue assignment** — Issues don't have assignees. They're worked through sequentially by rlph.

## Further Notes

- The `@laborer/mcp` package should be structured to potentially support additional MCP tools in the future (e.g., workspace management tools, terminal tools).
- The Plate.js dependency should be added to `apps/web` only. The `@laborer/mcp` and `@laborer/server` packages have no UI dependencies.
- The MCP auto-registration should log which config files it updated on each startup, so users can see what was touched.
- The `prdsDir` config field follows the same layered resolution pattern as `worktreeDir` — project-level overrides global, supports `~` expansion.
- PRD slugs are derived from titles using the same slugification logic as branch names (lowercase, hyphens, no special characters).
- The `.reference/plate/` directory should be set up (shallow clone of `udecode/plate`) for implementation reference.
