# PRD: Global Worktree Directory & Project Settings

## Problem Statement

Worktrees are currently created inside the project repository at `<repoPath>/.worktrees/<branchSlug>`. This pollutes the repo directory and causes issues with tooling that watches the repo — IDE indexers, file watchers, and `git status` all pick up the `.worktrees/` directory as noise. Developers have no way to configure where worktrees are placed, and there is no UI for managing project-level settings (setup scripts, rlph config) — these are buried in a JSON file that must be edited manually.

## Solution

Move the default worktree location to a global directory outside the repo (`~/.config/laborer/<projectName>/<branchSlug>`) and introduce a layered configuration system using a single `laborer.json` file format. A config file at the project root can override the global default, and the resolution walks up the directory tree. A new project settings modal (accessed via a gear icon on each project card) lets users view and edit all project settings — worktree directory, setup scripts, and rlph config — with changes written to the appropriate `laborer.json` file.

## User Stories

1. As a developer, I want worktrees created outside my repo directory by default, so that IDE indexers, file watchers, and `git status` are not polluted by worktree directories.
2. As a developer, I want a global default worktree base directory (`~/.config/laborer`), so that all projects use a consistent, out-of-repo location without per-project configuration.
3. As a developer, I want to override the worktree directory for a specific project via a config file at the project root, so that I can place worktrees on a faster disk or a custom location for that project.
4. As a developer, I want the config resolution to walk up the directory tree from the project root to find the nearest `laborer.json`, so that I can share config across multiple projects in a monorepo or org directory.
5. As a developer, I want a fallback to a hardcoded default (`~/.config/laborer/<projectName>`) when no config file exists, so that worktrees work out of the box without any configuration.
6. As a developer, I want the global config file at `~/.config/laborer/laborer.json` to be extensible, so that future global settings (editor command, default shell, etc.) can be added to the same file.
7. As a developer, I want a settings modal accessible via a gear icon on each project card, so that I can configure project settings without editing JSON files by hand.
8. As a developer, I want to see and edit the worktree directory path in the settings modal, so that I can customize where worktrees are created for this project.
9. As a developer, I want to see and edit setup scripts in the settings modal, so that I can manage the post-worktree-creation commands without opening a text editor.
10. As a developer, I want to see and edit the rlph config in the settings modal, so that all project-level settings are in one place.
11. As a developer, I want the settings modal to show the resolved value of each setting and where it came from (project file, ancestor file, global default), so that I understand the layered config resolution.
12. As a developer, I want changes made in the settings modal to be written to `laborer.json` at the project root, so that my overrides are local to the project.
13. As a developer, I want the existing `.laborer.json` format to be consolidated into the new `laborer.json` format, so that there is a single config file to maintain.
14. As a developer, I want the worktree path in the `laborer.json` to support `~` for the home directory, so that configs are portable across machines.
15. As a developer, I want the `laborer.json` at the project root to contain both team-shared settings (setupScripts) and user-specific settings (worktreeDir), so that I only have one config file to manage per project.
16. As a developer, I want the config to be re-read on each worktree creation (not cached), so that changes to `laborer.json` take effect immediately without restarting the server.
17. As a developer, I want the global config directory (`~/.config/laborer/`) to be created automatically if it doesn't exist, so that the default just works on first use.
18. As a developer, I want project name collisions in the global worktree directory (two repos named "api") to be accepted as-is, with the option to override via per-project config, so that the system stays simple and predictable.

## 'Polishing' Requirements

1. Verify the settings modal has consistent styling with existing dialogs (create workspace, add project, remove project confirmation).
2. Ensure all form fields in the settings modal have proper labels and ARIA attributes for accessibility.
3. Verify keyboard navigation works for opening the settings modal, tabbing between fields, and submitting/cancelling.
4. Ensure toast notifications confirm successful config saves and show meaningful errors on failure.
5. Verify the gear icon does not visually compete with the existing delete icon on project cards — check spacing, alignment, and visual weight.
6. Ensure the resolved config display (showing where each value comes from) is visually distinct but not overwhelming — subtle secondary text or tooltips rather than prominent labels.
7. Verify that `~` expansion works correctly in the worktree directory path on both macOS and Linux.
8. Ensure the settings modal loads quickly — config resolution should not block the UI.
9. Verify that the setup scripts editor handles edge cases gracefully: empty lists, scripts with special characters, very long command strings.
10. Ensure error messages from config file parse failures are user-friendly and suggest how to fix them.

## Implementation Decisions

### Config Service (new Effect service, server-side)

A new `ConfigService` Effect tagged service that encapsulates all config file I/O and resolution logic. This is a deep module with a simple interface:

- `resolveConfig(projectRepoPath: string) -> Effect<ResolvedLaborerConfig>` — walks up from the project root, merges with global config, applies defaults. Returns the fully resolved config with provenance metadata (which file each value came from).
- `writeProjectConfig(projectRepoPath: string, updates: Partial<LaborerConfig>) -> Effect<void>` — reads the existing `laborer.json` at the project root (or creates it), merges the updates, and writes it back. Only writes fields that are explicitly provided.
- `readGlobalConfig() -> Effect<LaborerConfig>` — reads `~/.config/laborer/laborer.json`, creating the directory and file with defaults if they don't exist.

**Config schema:**
```
{
  "worktreeDir": string (optional, supports ~ expansion),
  "setupScripts": string[] (optional),
  "rlphConfig": string (optional)
}
```

**Resolution order:**
1. Read `laborer.json` at the project root
2. Walk up parent directories looking for `laborer.json` files
3. Read global config at `~/.config/laborer/laborer.json`
4. Apply hardcoded defaults: `worktreeDir` = `~/.config/laborer/<projectName>`

Values merge with closest-to-project-root winning. Each resolved value carries provenance (file path it came from, or "default").

The config file name changes from `.laborer.json` to `laborer.json`. The old `readProjectConfig` function in WorkspaceProvider is removed entirely.

### WorkspaceProvider (modify)

- Remove the `WORKTREE_DIR` constant (currently `.worktrees`).
- Remove the `readProjectConfig` function and `LaborerConfig` interface.
- Depend on the new `ConfigService` to resolve the worktree directory and setup scripts.
- The worktree path computation changes from `resolve(project.repoPath, ".worktrees", slug)` to `resolve(resolvedConfig.worktreeDir, slug)`.
- The `resolvedConfig.worktreeDir` is already an absolute path (with `~` expanded) — no further path joining with the repo path.
- Setup scripts are read from the resolved config instead of the old `.laborer.json` file.

### RPC layer (modify shared definition + server handlers)

Two new RPC endpoints added to `LaborerRpcs`:

- `config.get` — payload: `{ projectId: string }`. Returns the fully resolved config with provenance. The handler looks up the project's `repoPath` from `ProjectRegistry`, then delegates to `ConfigService.resolveConfig`.
- `config.update` — payload: `{ projectId: string, config: Partial<LaborerConfig> }`. Writes the provided fields to `laborer.json` at the project root. The handler looks up the project's `repoPath`, then delegates to `ConfigService.writeProjectConfig`.

### Project Settings Modal (new frontend component)

- A new `ProjectSettingsModal` component, rendered as a `Dialog` (same primitive as create-workspace-form).
- Entry point: a gear icon (`Settings` from lucide-react) on each project card in `ProjectList`, next to the existing delete icon.
- On open, calls `config.get` RPC to fetch the resolved config with provenance.
- Form fields:
  - **Worktree directory**: text input showing the resolved path. Placeholder shows the default. Helper text shows provenance (e.g., "from ~/.config/laborer/laborer.json").
  - **Setup scripts**: an editable list of strings. Add/remove buttons for each entry. Each entry is a text input.
  - **rlph config**: text input for the rlph config string.
- Save button calls `config.update` RPC with only the changed fields.
- Uses the standard mutation pattern: `LaborerClient.mutation("config.update")` + `useAtomSet`.
- Toast notification on success/failure.

### Config file rename

All references to `.laborer.json` are updated to `laborer.json` throughout the codebase. This is a straightforward find-and-replace in code and documentation.

## Testing Decisions

Good tests verify external behavior through the public interface, not implementation details. Tests should set up realistic scenarios (real files on disk, real git repos where needed) and assert observable outcomes.

### Config Service tests

Test the public interface of the Config Service: `resolveConfig`, `writeProjectConfig`, `readGlobalConfig`.

Scenarios to cover:
- Walk-up resolution finds a `laborer.json` in an ancestor directory
- Project-root config overrides ancestor config (closest-wins)
- Global config is used as fallback when no local config exists
- Hardcoded default is used when no config files exist at all
- `~` in `worktreeDir` is expanded to the home directory
- `writeProjectConfig` creates `laborer.json` at project root if it doesn't exist
- `writeProjectConfig` merges with existing config (doesn't clobber unrelated fields)
- Provenance metadata correctly indicates the source file for each resolved value
- Malformed JSON in a config file is handled gracefully (logged, skipped)

Prior art: `packages/server/test/workspace-validation.test.ts` — uses real temporary directories and git operations, runs Effects with `Effect.runPromise`.

### WorkspaceProvider tests

Test that worktree creation uses the resolved config path instead of the hardcoded `.worktrees` directory.

Scenarios to cover:
- Worktree is created at `<resolvedWorktreeDir>/<branchSlug>` (not at `<repoPath>/.worktrees/`)
- Setup scripts are read from the resolved config
- When `worktreeDir` is not set in any config, the default `~/.config/laborer/<projectName>` is used

Prior art: `packages/server/test/workspace-validation.test.ts`.

### RPC handler tests

Test the `config.get` and `config.update` handlers end-to-end through the RPC layer.

Scenarios to cover:
- `config.get` returns resolved config with correct provenance for a registered project
- `config.get` returns an error for a non-existent project
- `config.update` writes to `laborer.json` at the project root
- `config.update` returns an error for a non-existent project

Prior art: existing handler patterns in `packages/server/src/rpc/handlers.ts` (though no handler tests exist yet — these would be the first).

### Frontend modal tests

Component tests for the settings modal.

Scenarios to cover:
- Modal opens when gear icon is clicked
- Form displays resolved config values
- Provenance labels show correct source files
- Save button triggers `config.update` RPC with changed fields
- Toast appears on successful save
- Error toast appears on failure

Prior art: no frontend component tests exist yet — these would be the first. Use Vitest + React Testing Library (or the project's existing test setup).

## Out of Scope

- **Migration of existing worktrees**: The app is in active development with state resets. Existing worktrees at `<repo>/.worktrees/` are not migrated. Only newly created worktrees use the new path.
- **Per-project overrides in the global config**: The global config only sets defaults. Per-project customization is done via `laborer.json` files in the project directory tree, not via a `projects` section in the global config.
- **Config file watching / hot reload**: Config is re-read on each worktree creation. There is no file watcher that detects external changes to `laborer.json` and pushes updates to the UI. The modal re-fetches on open.
- **Global settings UI**: There is no modal or UI for editing the global `~/.config/laborer/laborer.json`. Users edit it by hand. Only the project-level settings modal is built.
- **Config validation schema enforcement**: The config file is loosely typed JSON. There is no JSON Schema file published or strict validation beyond what the TypeScript interface expects. Unknown fields are preserved on write.
- **Docker/container worktree providers**: The worktree path configuration only applies to the git-worktree provider. Future container-based providers are out of scope.

## Further Notes

- The `laborer.json` file at the project root will likely be committed to version control (it contains team-shared `setupScripts`). The `worktreeDir` field is optional and user-specific — teams should establish a convention about whether to include it. It could be `.gitignore`d on a per-field basis by convention (don't commit your `worktreeDir`), but this is a social contract, not enforced by tooling.
- Project name is derived from `basename(repoPath)`. Two repos with the same directory name will share a worktree base directory under the default global path. This is accepted as a known limitation — users with name collisions can set a per-project `worktreeDir` override.
- The global config directory `~/.config/laborer/` will also serve as the default worktree base directory. Worktrees for a project "my-app" would be at `~/.config/laborer/my-app/<branchSlug>`. This keeps the filesystem layout clean and predictable.
- The `rlphConfig` field is currently stored on the `projects` LiveStore table. With this change, it moves to the config file. The LiveStore column should be kept for backward compatibility but the config file becomes the source of truth. The settings modal reads from and writes to the config file. The LiveStore column can be deprecated in a follow-up.
