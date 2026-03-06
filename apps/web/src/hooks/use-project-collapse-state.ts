/**
 * Hook to manage project collapse/expand state in the sidebar.
 *
 * Stores a `Record<string, boolean>` mapping project IDs to their
 * expanded state. Persisted to localStorage so collapse state survives
 * page reloads. Defaults to all projects expanded when no stored state
 * exists.
 *
 * @see Issue #168: ProjectGroup collapsible headings with nested workspaces
 */

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "laborer:project-collapse-state";

/**
 * Read the persisted collapse state from localStorage.
 * Returns undefined if nothing is stored or the stored value is invalid.
 */
function readStoredState(): Record<string, boolean> | undefined {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
		) {
			return parsed as Record<string, boolean>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Persist the collapse state to localStorage.
 */
function writeStoredState(state: Record<string, boolean>): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Silently ignore storage errors (e.g. quota exceeded)
	}
}

interface ProjectCollapseState {
	/** Check if a project is expanded. Defaults to true (expanded). */
	readonly isExpanded: (projectId: string) => boolean;
	/** Toggle the expanded state of a project. */
	readonly toggle: (projectId: string) => void;
}

function useProjectCollapseState(): ProjectCollapseState {
	const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>(
		() => readStoredState() ?? {}
	);

	// Persist to localStorage on every change
	useEffect(() => {
		writeStoredState(expandedMap);
	}, [expandedMap]);

	const isExpanded = useCallback(
		(projectId: string): boolean => {
			// Default to expanded (true) if not explicitly set
			return expandedMap[projectId] !== false;
		},
		[expandedMap]
	);

	const toggle = useCallback((projectId: string): void => {
		setExpandedMap((prev) => ({
			...prev,
			[projectId]: prev[projectId] === false,
		}));
	}, []);

	return { isExpanded, toggle };
}

export { useProjectCollapseState };
