/**
 * PanelHotkeys — Keyboard shortcuts for the panel system.
 *
 * Registers tmux-style keyboard shortcuts for panel operations using
 * TanStack Hotkeys' `useHotkeySequence` for prefix-key sequences.
 *
 * Tmux-style prefix key sequences (Ctrl+b then action key):
 * - Ctrl+b then h → split horizontal (side-by-side)
 * - Ctrl+b then v → split vertical (stacked)
 * - Ctrl+b then x → close active pane
 * - Ctrl+b then o → cycle focus to next pane
 * - Ctrl+b then p → cycle focus to previous pane
 * - Ctrl+b then d → toggle diff viewer alongside active terminal pane
 * - Ctrl+b then ArrowLeft → move focus left
 * - Ctrl+b then ArrowRight → move focus right
 * - Ctrl+b then ArrowUp → move focus up
 * - Ctrl+b then ArrowDown → move focus down
 * - Ctrl+b then Shift+ArrowLeft → shrink active pane (horizontal)
 * - Ctrl+b then Shift+ArrowRight → grow active pane (horizontal)
 * - Ctrl+b then Shift+ArrowUp → shrink active pane (vertical)
 * - Ctrl+b then Shift+ArrowDown → grow active pane (vertical)
 *
 * All shortcuts operate on the currently active (focused) pane.
 * The active pane is tracked via PanelActionsContext.
 *
 * @see Issue #71: PanelManager — navigate between panes (directional navigation)
 * @see Issue #75: Keyboard shortcut — split horizontal
 * @see Issue #76: Keyboard shortcut — split vertical (also done here)
 * @see Issue #77: Keyboard shortcut — close pane (also done here)
 * @see Issue #78: Keyboard shortcut — navigate panes (also done here)
 * @see Issue #79: Keyboard shortcut — resize panes
 * @see Issue #90: Toggle diff alongside terminal
 */

import type { PanelNode } from "@laborer/shared/types";
import { useHotkeySequence } from "@tanstack/react-hotkeys";
import { useEffect, useRef } from "react";
import type { NavigationDirection } from "@/panels/layout-utils";
import { findPaneInDirection } from "@/panels/layout-utils";
import { useActivePaneId, usePanelActions } from "@/panels/panel-context";

/** Timeout for the prefix key sequence (ms). */
const SEQUENCE_TIMEOUT = 1500;

interface PanelHotkeysProps {
	/**
	 * The root panel layout tree, used for directional navigation
	 * (arrow key shortcuts). Needed to resolve spatial relationships
	 * between panes based on split orientations.
	 */
	readonly layout?: PanelNode | undefined;
	/**
	 * All leaf pane IDs in order, used for cycling focus between panes.
	 * Passed from the layout owner which has access to the full tree.
	 */
	readonly leafPaneIds: readonly string[];
	/**
	 * Called when Cmd+W is pressed while no active pane exists.
	 * Used to show the close-app confirmation dialog.
	 */
	readonly onMetaWWithoutPane?: (() => void) | undefined;
}

function getResizeDirectionFromEvent(
	event: KeyboardEvent
): NavigationDirection | null {
	if (!event.shiftKey) {
		return null;
	}

	if (event.key === "ArrowRight") {
		return "right";
	}
	if (event.key === "ArrowLeft") {
		return "left";
	}
	if (event.key === "ArrowDown") {
		return "down";
	}
	if (event.key === "ArrowUp") {
		return "up";
	}

	return null;
}

/**
 * Registers all panel keyboard shortcuts.
 *
 * Must be rendered inside a PanelActionsProvider and HotkeysProvider.
 * This component renders nothing — it only registers event handlers.
 */
function PanelHotkeys({
	layout,
	leafPaneIds,
	onMetaWWithoutPane,
}: PanelHotkeysProps) {
	const actions = usePanelActions();
	const activePaneId = useActivePaneId();
	const resizePrefixActiveRef = useRef(false);
	const resizePrefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null
	);

	// Cmd+W (Meta+W) should close panes, not the Tauri window.
	// Capture at the window level so native close behavior is suppressed.
	useEffect(() => {
		const handleMetaW = (event: KeyboardEvent) => {
			if (
				event.metaKey &&
				!event.ctrlKey &&
				!event.altKey &&
				event.key === "w"
			) {
				event.preventDefault();
			}
		};

		window.addEventListener("keydown", handleMetaW);
		return () => {
			window.removeEventListener("keydown", handleMetaW);
		};
	}, []);

	useEffect(() => {
		const clearResizePrefix = () => {
			resizePrefixActiveRef.current = false;
			if (resizePrefixTimeoutRef.current !== null) {
				clearTimeout(resizePrefixTimeoutRef.current);
				resizePrefixTimeoutRef.current = null;
			}
		};

		const armResizePrefix = () => {
			clearResizePrefix();
			resizePrefixActiveRef.current = true;
			resizePrefixTimeoutRef.current = setTimeout(() => {
				resizePrefixActiveRef.current = false;
				resizePrefixTimeoutRef.current = null;
			}, SEQUENCE_TIMEOUT);
		};

		const handleResizeShortcut = (event: KeyboardEvent) => {
			if (
				event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				event.key.toLowerCase() === "b"
			) {
				armResizePrefix();
				return;
			}

			if (!resizePrefixActiveRef.current) {
				return;
			}

			if (event.key === "Shift") {
				return;
			}

			const direction = getResizeDirectionFromEvent(event);

			clearResizePrefix();

			if (!(actions && activePaneId && direction)) {
				return;
			}

			event.preventDefault();
			actions.resizePane(activePaneId, direction);
		};

		window.addEventListener("keydown", handleResizeShortcut);
		return () => {
			clearResizePrefix();
			window.removeEventListener("keydown", handleResizeShortcut);
		};
	}, [actions, activePaneId]);

	// Ctrl+b then h → split active pane horizontally
	useHotkeySequence(
		["Control+B", "H"],
		(event) => {
			event.preventDefault();
			if (actions && activePaneId) {
				actions.splitPane(activePaneId, "horizontal");
			}
		},
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then v → split active pane vertically
	useHotkeySequence(
		["Control+B", "V"],
		(event) => {
			event.preventDefault();
			if (actions && activePaneId) {
				actions.splitPane(activePaneId, "vertical");
			}
		},
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then x → close active pane
	useHotkeySequence(
		["Control+B", "X"],
		(event) => {
			event.preventDefault();
			if (actions && activePaneId) {
				actions.closePane(activePaneId);
			}
		},
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Cmd+w (Meta+W) → close active pane directly
	useHotkeySequence(["Meta+W"], (event) => {
		event.preventDefault();
		if (actions && activePaneId) {
			actions.closePane(activePaneId);
			return;
		}
		onMetaWWithoutPane?.();
	});

	// Ctrl+b then o → cycle focus to next pane
	useHotkeySequence(
		["Control+B", "O"],
		(event) => {
			event.preventDefault();
			if (!actions || leafPaneIds.length === 0) {
				return;
			}
			const currentIndex = activePaneId
				? leafPaneIds.indexOf(activePaneId)
				: -1;
			const nextIndex = (currentIndex + 1) % leafPaneIds.length;
			const nextPaneId = leafPaneIds[nextIndex];
			if (nextPaneId) {
				actions.setActivePaneId(nextPaneId);
			}
		},
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then p → cycle focus to previous pane
	useHotkeySequence(
		["Control+B", "P"],
		(event) => {
			event.preventDefault();
			if (!actions || leafPaneIds.length === 0) {
				return;
			}
			const currentIndex = activePaneId ? leafPaneIds.indexOf(activePaneId) : 0;
			const prevIndex =
				(currentIndex - 1 + leafPaneIds.length) % leafPaneIds.length;
			const prevPaneId = leafPaneIds[prevIndex];
			if (prevPaneId) {
				actions.setActivePaneId(prevPaneId);
			}
		},
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then d → toggle diff viewer alongside active terminal pane
	useHotkeySequence(
		["Control+B", "D"],
		(event) => {
			event.preventDefault();
			if (actions && activePaneId) {
				actions.toggleDiffPane(activePaneId);
			}
		},
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// --- Directional navigation (Ctrl+b then arrow key) ---
	// Navigate to the pane in the given direction based on the layout
	// tree's spatial structure (split orientations).
	const navigateDirection = (
		event: KeyboardEvent,
		direction: NavigationDirection
	) => {
		event.preventDefault();
		if (!(actions && activePaneId && layout)) {
			return;
		}
		const targetId = findPaneInDirection(layout, activePaneId, direction);
		if (targetId) {
			actions.setActivePaneId(targetId);
		}
	};

	// Ctrl+b then ArrowLeft → move focus to the pane on the left
	useHotkeySequence(
		["Control+B", "ArrowLeft"],
		(event) => navigateDirection(event, "left"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then ArrowRight → move focus to the pane on the right
	useHotkeySequence(
		["Control+B", "ArrowRight"],
		(event) => navigateDirection(event, "right"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then ArrowUp → move focus to the pane above
	useHotkeySequence(
		["Control+B", "ArrowUp"],
		(event) => navigateDirection(event, "up"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then ArrowDown → move focus to the pane below
	useHotkeySequence(
		["Control+B", "ArrowDown"],
		(event) => navigateDirection(event, "down"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// --- Resize shortcuts (Ctrl+b then Shift+arrow key) ---
	// Resize the active pane by growing or shrinking it in the
	// direction of the arrow key.
	const resizeDirection = (
		event: KeyboardEvent,
		direction: NavigationDirection
	) => {
		event.preventDefault();
		if (actions && activePaneId) {
			actions.resizePane(activePaneId, direction);
		}
	};

	// Ctrl+b then Shift+ArrowRight → grow active pane horizontally
	useHotkeySequence(
		["Control+B", "Shift+ArrowRight"],
		(event) => resizeDirection(event, "right"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then Shift+ArrowLeft → shrink active pane horizontally
	useHotkeySequence(
		["Control+B", "Shift+ArrowLeft"],
		(event) => resizeDirection(event, "left"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then Shift+ArrowDown → grow active pane vertically
	useHotkeySequence(
		["Control+B", "Shift+ArrowDown"],
		(event) => resizeDirection(event, "down"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	// Ctrl+b then Shift+ArrowUp → shrink active pane vertically
	useHotkeySequence(
		["Control+B", "Shift+ArrowUp"],
		(event) => resizeDirection(event, "up"),
		{ timeout: SEQUENCE_TIMEOUT }
	);

	return null;
}

export { PanelHotkeys };
