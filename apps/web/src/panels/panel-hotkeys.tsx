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
 *
 * All shortcuts operate on the currently active (focused) pane.
 * The active pane is tracked via PanelActionsContext.
 *
 * @see Issue #75: Keyboard shortcut — split horizontal
 * @see Issue #76: Keyboard shortcut — split vertical (also done here)
 * @see Issue #77: Keyboard shortcut — close pane (also done here)
 * @see Issue #78: Keyboard shortcut — navigate panes (also done here)
 * @see Issue #90: Toggle diff alongside terminal
 */

import { useHotkeySequence } from "@tanstack/react-hotkeys";
import { useActivePaneId, usePanelActions } from "@/panels/panel-context";

/** Timeout for the prefix key sequence (ms). */
const SEQUENCE_TIMEOUT = 1500;

interface PanelHotkeysProps {
	/**
	 * All leaf pane IDs in order, used for cycling focus between panes.
	 * Passed from the layout owner which has access to the full tree.
	 */
	readonly leafPaneIds: readonly string[];
}

/**
 * Registers all panel keyboard shortcuts.
 *
 * Must be rendered inside a PanelActionsProvider and HotkeysProvider.
 * This component renders nothing — it only registers event handlers.
 */
function PanelHotkeys({ leafPaneIds }: PanelHotkeysProps) {
	const actions = usePanelActions();
	const activePaneId = useActivePaneId();

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

	return null;
}

export { PanelHotkeys };
