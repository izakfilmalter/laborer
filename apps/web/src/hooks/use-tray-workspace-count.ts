/**
 * Tauri system tray workspace count sync hook.
 *
 * Keeps the system tray tooltip in sync with the number of running workspaces
 * by calling the Rust `update_tray_workspace_count` command whenever the
 * reactive workspace count changes.
 *
 * Only runs when the app is inside the Tauri desktop shell (detected via
 * `window.__TAURI_INTERNALS__`). In browser mode, the hook is a no-op.
 *
 * @see Issue #115: Tauri system tray
 */

import { workspaces } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";

import { useLaborerStore } from "@/livestore/store";

/** LiveStore query for all non-destroyed workspaces with "running" status. */
const runningWorkspaces$ = queryDb(workspaces.where({ status: "running" }), {
	label: "trayRunningWorkspaces",
});

/** Check if running inside Tauri desktop shell. */
function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Sync the running workspace count to the Tauri system tray tooltip.
 *
 * Call this hook once at the app root level. It subscribes to the LiveStore
 * `workspaces` table, counts rows with status "running", and invokes the
 * Rust command `update_tray_workspace_count` when the count changes.
 */
function useTrayWorkspaceCount(): void {
	const store = useLaborerStore();
	const runningWs = store.useQuery(runningWorkspaces$);
	const count = runningWs.length;
	const prevCountRef = useRef<number>(-1);

	useEffect(() => {
		if (!isTauri()) {
			return;
		}
		if (count === prevCountRef.current) {
			return;
		}
		prevCountRef.current = count;

		invoke("update_tray_workspace_count", { count }).catch(() => {
			// Silently ignore — tray may not be available in all environments
		});
	}, [count]);
}

export { useTrayWorkspaceCount };
