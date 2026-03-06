# MCP Server & PRD-Driven Task Workflow — Issues

---

## Issue 175: PRDs table and events in LiveStore schema

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add a new `prds` table to the LiveStore schema and the corresponding synced events and materializers. This is the foundational data layer for all PRD functionality.

The `prds` table has columns: `id` (text PK, branded `PrdId`), `projectId` (text), `title` (text), `slug` (text), `filePath` (text), `status` (text, default `"draft"`), `createdAt` (text). Status values are `"draft"`, `"active"`, `"completed"`.

Add a `PrdId` branded string type and `PrdStatus` literal type to the shared types module. Add events `prdCreated`, `prdStatusChanged`, `prdRemoved` with appropriate schemas. Add materializers mapping each event to the correct table operation. Register the `prds` table in `activeTables`.

### Acceptance criteria

- [x] `prds` table is defined with all columns (id, projectId, title, slug, filePath, status, createdAt)
- [x] `PrdId` branded type and `PrdStatus` literal type exist in shared types
- [x] `prdCreated` event inserts a row into the prds table
- [x] `prdStatusChanged` event updates the status column
- [x] `prdRemoved` event deletes the row
- [x] `prds` table is included in `activeTables` and the schema exports
- [x] Existing tables and events are unaffected

### Blocked by

None - can start immediately

### User stories addressed

- User story 3

---

## Issue 176: Tasks table: add prdId column

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add a nullable `prdId` column to the existing `tasks` table so that tasks with source `"prd"` can be linked to a specific PRD. Update the `taskCreated` event schema to include an optional `prdId` field. Update the materializer to pass `prdId` through on insert. Existing tasks will have null `prdId`.

### Acceptance criteria

- [x] `tasks` table has a new nullable `prdId` column of type text
- [x] `taskCreated` event schema includes an optional `prdId` field
- [x] `taskCreated` materializer passes `prdId` to the insert operation
- [x] Existing tasks are unaffected (null prdId)
- [x] TaskManager's `createTask` method accepts an optional `prdId` parameter

### Blocked by

None - can start immediately

### User stories addressed

- User story 6

---

## Issue 177: PrdStorageService: create and read PRD files on disk

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Create a new `PrdStorageService` Effect tagged service in `@laborer/server` that manages PRD markdown files on disk. The service handles creating PRD files at the correct path, reading them back, and resolving the PRDs directory.

The default PRDs directory is `~/.config/laborer/<projectName>/prds/`. Add a `prdsDir` field to `laborer.json` config schema so users can customize this path. The `PrdStorageService` uses `ConfigService` to resolve the path, auto-creates the directory if it doesn't exist, and performs atomic writes (temp file + rename).

Slug generation: convert the PRD title to a URL/file-safe slug (lowercase, hyphens, no special characters). File naming: `PRD-<slug>.md`.

### Acceptance criteria

- [ ] `PrdStorageService` is defined as an Effect tagged service following the existing `Context.Tag` + `Layer.effect` pattern
- [ ] `createPrdFile(projectName, title, content)` writes a markdown file at the resolved path and returns the file path
- [ ] `readPrdFile(filePath)` reads and returns the markdown content
- [ ] PRDs directory is auto-created if it doesn't exist
- [ ] Slug generation produces URL-safe names from titles
- [ ] `prdsDir` field is added to the `laborer.json` config schema
- [ ] ConfigService resolves `prdsDir` with the same layered strategy as `worktreeDir`
- [ ] File writes use the atomic temp-file + rename strategy

### Blocked by

- Blocked by #175

### User stories addressed

- User story 3, 4, 5

---

## Issue 178: PRD create and list RPCs

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add `prd.create` and `prd.list` RPC endpoints to `LaborerRpcs`. Define a `PrdResponse` schema for the return type. Implement handlers that use `PrdStorageService` to write the file and commit `prdCreated` events to LiveStore.

`prd.create` accepts `projectId`, `title`, and `content` (markdown string). It generates a slug, writes the file via `PrdStorageService`, commits `prdCreated` to LiveStore, and returns the PRD metadata.

`prd.list` accepts `projectId` and queries LiveStore for all PRDs belonging to that project. Returns an array of PRD metadata (id, title, slug, status, createdAt).

Wire the new service layer into `main.ts`.

### Acceptance criteria

- [ ] `PrdResponse` schema is defined with id, projectId, title, slug, filePath, status, createdAt
- [ ] `prd.create` RPC is defined in `LaborerRpcs` with success and error schemas
- [ ] `prd.list` RPC is defined in `LaborerRpcs`
- [ ] `prd.create` handler writes the PRD file and commits `prdCreated` event
- [ ] `prd.list` handler queries LiveStore and returns PRD metadata
- [ ] `PrdStorageService.layer` is wired into `main.ts`
- [ ] Creating a PRD with a duplicate title for the same project returns an error

### Blocked by

- Blocked by #177

### User stories addressed

- User story 3

---

## Issue 179: PRD read and remove RPCs

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add `prd.read` and `prd.remove` RPC endpoints to `LaborerRpcs`.

`prd.read` accepts a `prdId`, looks up the file path from LiveStore, reads the markdown content via `PrdStorageService`, and returns it along with the PRD metadata.

`prd.remove` accepts a `prdId`, deletes the PRD file and its associated issues file from disk, removes any linked tasks from LiveStore, and commits a `prdRemoved` event.

### Acceptance criteria

- [ ] `prd.read` RPC is defined with prdId payload and returns PRD metadata + markdown content
- [ ] `prd.read` handler reads the file from disk and returns the content
- [ ] `prd.read` returns an error if the PRD doesn't exist
- [ ] `prd.remove` RPC is defined with prdId payload
- [ ] `prd.remove` handler deletes the PRD file from disk
- [ ] `prd.remove` handler deletes the associated issues file if it exists
- [ ] `prd.remove` handler removes linked tasks (source "prd" with matching prdId) from LiveStore
- [ ] `prd.remove` handler commits `prdRemoved` event

### Blocked by

- Blocked by #178

### User stories addressed

- User story 3

---

## Issue 180: PRD update RPC and status changes

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add `prd.update` and `prd.updateStatus` RPC endpoints to `LaborerRpcs`. Add the `prdUpdated` event to the LiveStore schema.

`prd.update` accepts `prdId` and `content` (new markdown). Overwrites the PRD file on disk via `PrdStorageService` and commits a `prdUpdated` event.

`prd.updateStatus` accepts `prdId` and `status` (draft/active/completed). Commits a `prdStatusChanged` event.

### Acceptance criteria

- [ ] `prdUpdated` event is defined in the schema with appropriate fields
- [ ] `prdUpdated` materializer updates the prds table correctly
- [ ] `prd.update` RPC accepts prdId and content, overwrites the file, and commits `prdUpdated`
- [ ] `prd.updateStatus` RPC accepts prdId and status, commits `prdStatusChanged`
- [ ] Invalid status values return an error
- [ ] Updating a non-existent PRD returns an error

### Blocked by

- Blocked by #179

### User stories addressed

- User story 16

---

## Issue 181: Issue creation RPC: prd.createIssue

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add a `prd.createIssue` RPC endpoint that creates a single issue linked to a PRD. This writes the issue to the PRD's companion issues file (`PRD-<slug>-issues.md`) and creates a task in LiveStore with source `"prd"` and the `prdId` set.

The issues file uses the markdown format from the PRD (title as `## Issue <number>: <title>`, followed by sections for Parent PRD, What to build, Acceptance criteria, Blocked by, User stories addressed). The RPC accepts `prdId`, `title`, and `body` (the full issue markdown body). It appends the issue to the file with a separator.

`PrdStorageService` gains methods for creating and appending to the issues file.

### Acceptance criteria

- [ ] `prd.createIssue` RPC is defined with prdId, title, and body payload
- [ ] Handler creates the issues file if it doesn't exist
- [ ] Handler appends the issue in the correct markdown format with separator
- [ ] Handler creates a task in LiveStore with source "prd", the prdId, and an auto-generated externalId
- [ ] The task title matches the issue title
- [ ] The created task is returned in the response
- [ ] Creating an issue for a non-existent PRD returns an error

### Blocked by

- Blocked by #176, #178

### User stories addressed

- User story 2, 15

---

## Issue 182: Issue read and list RPCs: prd.readIssues, prd.listRemainingIssues

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add `prd.readIssues` and `prd.listRemainingIssues` RPC endpoints.

`prd.readIssues` accepts a `prdId`, reads the companion issues file from disk via `PrdStorageService`, and returns the full markdown content.

`prd.listRemainingIssues` accepts a `prdId` and queries LiveStore for tasks with source `"prd"` and matching `prdId` that have status `"pending"` or `"in_progress"`. Returns the task records with their full details.

### Acceptance criteria

- [ ] `prd.readIssues` RPC is defined and returns the issues file content as a string
- [ ] `prd.readIssues` returns an empty string if no issues file exists
- [ ] `prd.listRemainingIssues` RPC is defined and returns an array of task records
- [ ] `prd.listRemainingIssues` filters to only pending and in_progress tasks
- [ ] `prd.listRemainingIssues` filters by both prdId and source "prd"
- [ ] Querying a non-existent PRD returns an error

### Blocked by

- Blocked by #181

### User stories addressed

- User story 6, 19, 26

---

## Issue 183: Issue update RPC: prd.updateIssue

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add a `prd.updateIssue` RPC endpoint that updates an issue's content in the companion issues file and optionally updates the task status in LiveStore.

`PrdStorageService` gains a method to find and replace a specific issue section in the issues markdown file by matching on issue number or title. The RPC accepts `taskId`, optional `body` (new markdown content for the issue section), and optional `status`.

### Acceptance criteria

- [ ] `prd.updateIssue` RPC is defined with taskId, optional body, and optional status
- [ ] When body is provided, the corresponding issue section in the markdown file is replaced
- [ ] When status is provided, the task status is updated in LiveStore via TaskManager
- [ ] Updating a non-existent task returns an error
- [ ] The issue file is preserved correctly when updating a single issue (other issues untouched)

### Blocked by

- Blocked by #182

### User stories addressed

- User story 16

---

## Issue 184: `@laborer/mcp` package scaffold: stdio server with project discovery

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Create a new `packages/mcp/` package with the `@laborer/mcp` name. Set up the package.json mirroring `@laborer/terminal` (dependencies: `@effect/ai`, `@effect/platform`, `@effect/platform-bun`, `@effect/rpc`, `@laborer/env`, `@laborer/shared`, `effect`). Add scripts for dev, build, start, test.

The entry point creates a `McpServer` using `McpServer.layerStdio` from `@effect/ai` with name "laborer" and appropriate version. It establishes an RPC client connection to the main Laborer server at `http://localhost:<PORT>/rpc`.

Implement project discovery: the MCP server reads the list of registered projects via the RPC client and matches the AI agent's current working directory against project `repoPath` values by walking up from cwd. Expose the discovered project context to all tool handlers.

Register the package in the root `package.json` workspaces and turbo config.

### Acceptance criteria

- [ ] `packages/mcp/` directory exists with package.json, tsconfig, and entry point
- [ ] Package builds successfully with `bun run build`
- [ ] McpServer starts over stdio transport using `@effect/ai` McpServer
- [ ] RPC client connects to the main Laborer server
- [ ] Project discovery matches cwd against registered project repoPaths
- [ ] Project discovery walks up directories to find a matching project
- [ ] Error is returned if no matching project is found
- [ ] Package is registered in root workspace config

### Blocked by

None - can start immediately

### User stories addressed

- User story 8, 17, 18

---

## Issue 185: MCP PRD tools: create_prd, read_prd, update_prd, list_prds

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Register four MCP tools in the `@laborer/mcp` server for PRD management. Each tool delegates to the corresponding `prd.*` RPC on the main server.

- `create_prd`: accepts title and content, calls `prd.create` with the discovered projectId
- `read_prd`: accepts prdId or title, calls `prd.read`
- `update_prd`: accepts prdId and content, calls `prd.update`
- `list_prds`: no required params, calls `prd.list` with the discovered projectId

Tools are registered using the `McpServer.resource` or `McpServer.toolkit` pattern from `@effect/ai`. Each tool has a clear description and typed input schema so AI agents can discover and use them.

### Acceptance criteria

- [ ] `create_prd` tool is registered with title and content parameters
- [ ] `read_prd` tool is registered and returns PRD markdown content
- [ ] `update_prd` tool is registered and overwrites PRD content
- [ ] `list_prds` tool is registered and returns PRD summaries for the current project
- [ ] All tools use the discovered project context (no explicit projectId parameter)
- [ ] Tool descriptions are clear and useful for AI agent discovery
- [ ] Input schemas are properly typed with Effect Schema
- [ ] Errors from the main server are propagated back as tool errors

### Blocked by

- Blocked by #180, #184

### User stories addressed

- User story 1, 16

---

## Issue 186: MCP issue tools: create_issue, read_issues, update_issue, list_remaining_issues

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Register four MCP tools in the `@laborer/mcp` server for issue management. Each tool delegates to the corresponding `prd.*` RPC on the main server.

- `create_issue`: accepts prdId, title, and body (markdown), calls `prd.createIssue`
- `read_issues`: accepts prdId, calls `prd.readIssues`
- `update_issue`: accepts taskId, optional body, optional status, calls `prd.updateIssue`
- `list_remaining_issues`: accepts prdId, calls `prd.listRemainingIssues`

### Acceptance criteria

- [ ] `create_issue` tool is registered with prdId, title, and body parameters
- [ ] `read_issues` tool is registered and returns the full issues markdown
- [ ] `update_issue` tool is registered with taskId, optional body, and optional status
- [ ] `list_remaining_issues` tool is registered and returns only pending/in_progress issues
- [ ] Tool descriptions clearly explain their purpose for AI agent discovery
- [ ] Issues created through MCP appear in LiveStore and are queryable by the UI

### Blocked by

- Blocked by #183, #184

### User stories addressed

- User story 2, 14, 15, 26

---

## Issue 187: MCP auto-registration: Opencode config

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Create an `McpRegistrar` Effect service in `@laborer/server` that writes the Laborer MCP server entry to the Opencode config file on server startup.

On startup, the registrar reads `~/.config/opencode/config.json`, adds or updates the `laborer` entry under `mcpServers` with the correct command and args to start the `@laborer/mcp` stdio server, and writes the file back. The write is idempotent — it only modifies the `laborer` key and preserves all other entries.

The registrar runs as part of the server startup sequence (in `main.ts`), after LiveStore is initialized.

### Acceptance criteria

- [ ] `McpRegistrar` is defined as an Effect tagged service
- [ ] On startup, it reads the Opencode config file at `~/.config/opencode/config.json`
- [ ] It adds a `laborer` entry to `mcpServers` with command `bun` and args pointing to the MCP package entry
- [ ] Existing `mcpServers` entries are preserved
- [ ] If the `laborer` entry already exists with the same config, the file is not rewritten
- [ ] If the config file doesn't exist, it creates it with the correct structure
- [ ] The registrar logs which files it updated
- [ ] Registration errors are logged as warnings (don't crash the server)

### Blocked by

- Blocked by #184

### User stories addressed

- User story 7, 25

---

## Issue 188: MCP auto-registration: Claude Code and Codex configs

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Extend the `McpRegistrar` service to also register the Laborer MCP server with Claude Code and Codex.

**Claude Code:** Write to the Claude Code MCP config file (determine the correct path — likely `~/.claude.json` or `~/.config/claude/config.json`). Same pattern as Opencode: add `laborer` to `mcpServers`, preserve existing entries.

**Codex:** Write to the Codex config file (determine the correct path). Same pattern.

Each target config format may differ slightly — the registrar handles format differences per target.

### Acceptance criteria

- [ ] Claude Code config is updated with the laborer MCP entry
- [ ] Codex config is updated with the laborer MCP entry
- [ ] Each config file format is handled correctly (different JSON structures)
- [ ] Existing entries in both configs are preserved
- [ ] Registration is idempotent for all three targets
- [ ] Missing config files are created with correct structure
- [ ] Failures for one target don't prevent registration with other targets

### Blocked by

- Blocked by #187

### User stories addressed

- User story 7, 25

---

## Issue 189: Plans sidebar section: PlanList component

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add a collapsible "Plans" sub-section to each `ProjectGroup` in the sidebar, positioned between Workspaces and Tasks. Create a `PlanList` component that queries LiveStore for PRDs belonging to the project and renders a list of plan items.

Each plan item shows the PRD title and an issue progress indicator (e.g., "3/7 done" or a small progress bar). The progress is computed by counting tasks with source `"prd"` and matching `prdId`, grouped by status.

Clicking a plan item will eventually open the plan detail view (wired in a later issue). For now, clicking selects the plan visually (highlighted state).

### Acceptance criteria

- [ ] A "Plans" sub-section appears under each project group in the sidebar
- [ ] The section is collapsible, consistent with the Workspaces section style
- [ ] `PlanList` queries LiveStore for PRDs with the project's ID
- [ ] Each plan item displays the PRD title
- [ ] Each plan item shows an issue progress indicator (completed/total)
- [ ] Plans are ordered by creation date (newest first)
- [ ] Empty state is shown when a project has no plans
- [ ] Visual styling is consistent with existing sidebar sections

### Blocked by

- Blocked by #175

### User stories addressed

- User story 9, 21

---

## Issue 190: Plan detail view: Plate.js markdown editor

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Create a `PlanEditor` component that displays a PRD's markdown content in a Plate.js editor. When a plan is selected in the sidebar, the main content area (or a panel) shows this editor.

Set up Plate.js with minimal plugins: paragraph, heading (h1-h6), list (ordered/unordered), bold, italic, code (inline), code block, link, blockquote, table. Add markdown serialization and deserialization so content round-trips between the markdown file and the editor without loss.

The editor loads content via the `prd.read` RPC and saves via `prd.update` on blur or with a debounced auto-save. Add `@udecode/plate` and required plugin packages to `apps/web` dependencies.

### Acceptance criteria

- [ ] Plate.js is installed and configured with minimal markdown plugins
- [ ] `PlanEditor` renders the PRD markdown content in a WYSIWYG editor
- [ ] Markdown is deserialized to Plate nodes on load
- [ ] Plate nodes are serialized back to markdown on save
- [ ] Round-trip serialization preserves content (no formatting loss)
- [ ] Editor saves content via `prd.update` RPC on blur or auto-save
- [ ] Editor shows a loading state while fetching content
- [ ] Editor handles errors (file not found, save failure) with user-friendly messages
- [ ] Selecting a plan in the sidebar opens the editor in the main content area

### Blocked by

- Blocked by #180, #189

### User stories addressed

- User story 10, 27

---

## Issue 191: Plan detail view: issues list alongside editor

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add a `PlanIssuesList` component that renders alongside the `PlanEditor` in the plan detail view. The component queries LiveStore for tasks with source `"prd"` and matching `prdId`, displaying them as a list with status indicators.

Each issue shows: title, status icon (using the same visual language as `TaskList`), and a status dropdown to change status. The issues list is reactive — status changes propagate in real-time via LiveStore.

Layout: the plan detail view is split with the editor on the left/top and the issues list on the right/bottom (responsive based on available space).

### Acceptance criteria

- [ ] `PlanIssuesList` renders all issues for a given prdId
- [ ] Issues display title and status icon consistent with existing TaskList styling
- [ ] Status dropdown allows changing issue status (pending, in_progress, completed, cancelled)
- [ ] Status changes call `task.updateStatus` RPC and update in real-time
- [ ] Layout splits editor and issues list responsively
- [ ] Empty state shown when a plan has no issues
- [ ] Issues are ordered by creation order (matching the order in the issues file)

### Blocked by

- Blocked by #181, #190

### User stories addressed

- User story 11, 19, 20

---

## Issue 192: Create workspace from plan

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Add a "Create Workspace" button to the plan detail view that creates a single workspace linked to the plan. The button calls `workspace.create` with the project ID and a branch name derived from the plan slug (e.g., `plan/<slug>`).

The workspace should be visually associated with the plan — it appears in the plan detail view and in the project's workspace list. The button is disabled with a tooltip when a workspace already exists for this plan.

Track the plan-workspace association: either by convention (branch name prefix `plan/`) or by storing the prdId on the workspace (add optional `prdId` to workspace if needed).

### Acceptance criteria

- [ ] "Create Workspace" button appears in the plan detail view
- [ ] Clicking the button creates a workspace via `workspace.create` RPC
- [ ] Branch name is derived from the plan slug (e.g., `plan/<slug>`)
- [ ] The button is disabled with a tooltip when a workspace already exists for this plan
- [ ] The created workspace appears in the plan detail view
- [ ] The created workspace appears in the project's workspace list in the sidebar
- [ ] Workspace creation uses the same flow as `CreateWorkspaceForm` (progress, error handling)

### Blocked by

- Blocked by #191

### User stories addressed

- User story 12, 13

---

## Issue 193: Plan workspace scoped task list and rlph integration

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

When viewing a workspace that is associated with a plan, show a slimmed-down task list scoped to that plan's issues instead of the full project task list. The user can kick off rlph in this workspace, and rlph can use the MCP tools (`list_remaining_issues`, `read_prd`) to get full context about the plan and remaining work.

The scoped task list shows only tasks with the plan's `prdId`. The rlph "start loop" button remains user-triggered per workspace (same as today).

### Acceptance criteria

- [ ] Workspace view detects when a workspace is associated with a plan
- [ ] Workspace view shows a scoped task list with only the plan's issues
- [ ] The scoped task list uses the same visual components as the full task list
- [ ] rlph can be started in the workspace via the existing start loop button
- [ ] rlph can call MCP tools to read the PRD and remaining issues
- [ ] Issue status updates in the scoped list propagate to the sidebar plan progress indicator

### Blocked by

- Blocked by #186, #192

### User stories addressed

- User story 13, 14, 20

---

## Issue 194: Remove CreateTaskForm and manual task source tab

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Remove the `CreateTaskForm` component and the "Manual" tab from `TaskSourcePicker`. Tasks with source `"manual"` can no longer be created through the UI — the PRD-driven flow replaces manual task creation.

The `TaskSourcePicker` retains the Linear, GitHub, and PRD source tabs. The `task.create` RPC endpoint remains (it may be used by the MCP server), but the UI no longer exposes manual task creation.

### Acceptance criteria

- [ ] `CreateTaskForm` component file is deleted
- [ ] "Manual" tab is removed from `TaskSourcePicker`
- [ ] `TaskSourcePicker` still shows Linear, GitHub, and PRD tabs
- [ ] Existing manual tasks still display correctly in the task list (read-only, status changes still work)
- [ ] No dead imports or references to `CreateTaskForm` remain
- [ ] The `task.create` RPC endpoint is not removed (still used by MCP)

### Blocked by

- Blocked by #181

### User stories addressed

- User story 23

---

## Issue 195: Remove WritePrdForm, rlph.writePRD RPC, and PrdTaskImporter

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

Remove the old rlph-based PRD writing flow:

1. Delete the `WritePrdForm` component and all references to it (the FileText icon button in workspace cards).
2. Remove the `rlph.writePRD` RPC definition from `LaborerRpcs` and its handler from the handlers file.
3. Remove the `PrdTaskImporter` service entirely — the terminal output scraping logic is replaced by the MCP-based issue creation.
4. Remove `PrdTaskImporter.layer` from the server's layer composition in `main.ts`.

### Acceptance criteria

- [ ] `WritePrdForm` component file is deleted
- [ ] All references to `WritePrdForm` are removed from workspace components
- [ ] `rlph.writePRD` RPC is removed from `LaborerRpcs`
- [ ] `rlph.writePRD` handler is removed from the handlers file
- [ ] `PrdTaskImporter` service file is deleted
- [ ] `PrdTaskImporter.layer` is removed from `main.ts`
- [ ] No dead imports or references to any of the removed code remain
- [ ] The remaining rlph RPCs (`rlph.startLoop`, `rlph.review`, `rlph.fix`) still work

### Blocked by

- Blocked by #185

### User stories addressed

- User story 24

---

## Issue 196: Polish and end-to-end verification

### Parent PRD

PRD-mcp-prd-driven-tasks.md

### What to build

End-to-end verification and polish pass for the full MCP + PRD-driven task workflow. Verify all polishing requirements from the PRD across the complete integration.

### Acceptance criteria

- [ ] Plans sub-section has consistent visual hierarchy with Workspaces and Tasks sections
- [ ] Plate.js editor loads without layout shift or flash of unstyled content
- [ ] Plan detail view is responsive at various sidebar widths
- [ ] Issue status indicators use the same colors and icons as the existing task list
- [ ] "Create Workspace" button is disabled with tooltip when workspace already exists
- [ ] MCP auto-registration preserves user-added MCP servers in AI tool configs
- [ ] MCP server handles concurrent tool calls gracefully
- [ ] Error states in the plan editor show clear, actionable messages
- [ ] Keyboard navigation works for the Plans section (Tab, Enter, shortcuts)
- [ ] Plan workspace scoped task list updates in real-time
- [ ] Workspace branch name derived from plan name is sensible
- [ ] Plate.js editor preserves markdown formatting on round-trip
- [ ] No visual regressions in existing sidebar sections, task lists, or workspace cards

### Blocked by

- Blocked by #188, #193, #194, #195

### User stories addressed

- All polishing requirements

---

## Summary

| # | Title | Blocked by | Status |
|---|-------|-----------|--------|
| 175 | PRDs table and events in LiveStore schema | None | Done |
| 176 | Tasks table: add prdId column | None | Done |
| 177 | PrdStorageService: create and read PRD files on disk | #175 | Ready |
| 178 | PRD create and list RPCs | #177 | Blocked |
| 179 | PRD read and remove RPCs | #178 | Blocked |
| 180 | PRD update RPC and status changes | #179 | Blocked |
| 181 | Issue creation RPC: prd.createIssue | #178 | Blocked |
| 182 | Issue read and list RPCs | #181 | Blocked |
| 183 | Issue update RPC: prd.updateIssue | #182 | Blocked |
| 184 | `@laborer/mcp` package scaffold: stdio server with project discovery | None | Ready |
| 185 | MCP PRD tools: create_prd, read_prd, update_prd, list_prds | #180, #184 | Blocked |
| 186 | MCP issue tools: create_issue, read_issues, update_issue, list_remaining_issues | #183, #184 | Blocked |
| 187 | MCP auto-registration: Opencode config | #184 | Blocked |
| 188 | MCP auto-registration: Claude Code and Codex configs | #187 | Blocked |
| 189 | Plans sidebar section: PlanList component | #175 | Ready |
| 190 | Plan detail view: Plate.js markdown editor | #180, #189 | Blocked |
| 191 | Plan detail view: issues list alongside editor | #181, #190 | Blocked |
| 192 | Create workspace from plan | #191 | Blocked |
| 193 | Plan workspace scoped task list and rlph integration | #186, #192 | Blocked |
| 194 | Remove CreateTaskForm and manual task source tab | #181 | Blocked |
| 195 | Remove WritePrdForm, rlph.writePRD RPC, and PrdTaskImporter | #185 | Blocked |
| 196 | Polish and end-to-end verification | #188, #193, #194, #195 | Blocked |
