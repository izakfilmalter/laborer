/**
 * Shared git command options for the repo-watching stack.
 *
 * Correctness-sensitive reads in this feature bypass git fsmonitor so
 * watcher-driven reconciliation and branch refresh are not influenced by
 * stale git-side filesystem caching.
 *
 * @see PRD-opencode-inspired-repo-watching.md — Issue 7
 */

const REPO_WATCHING_GIT_CONFIG = ["-c", "core.fsmonitor=false"] as const;

const withFsmonitorDisabled = (args: readonly string[]): readonly string[] => [
	...REPO_WATCHING_GIT_CONFIG,
	...args,
];

export { REPO_WATCHING_GIT_CONFIG, withFsmonitorDisabled };
