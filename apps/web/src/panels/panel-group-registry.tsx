/**
 * PanelGroupRegistry — Stores imperative handles for ResizablePanelGroup
 * instances in the panel tree, keyed by SplitNode ID.
 *
 * This enables programmatic panel resizing via keyboard shortcuts.
 * Each SplitPanelRenderer registers its GroupImperativeHandle on mount
 * and unregisters on unmount. The resize logic uses these handles to
 * call `setLayout()` on the correct panel group.
 *
 * @see Issue #79: Keyboard shortcut — resize panes
 */

import { createContext, useCallback, useContext, useRef } from "react";
import type { GroupImperativeHandle } from "react-resizable-panels";

interface PanelGroupRegistryValue {
	/**
	 * Get the imperative handle for a panel group by its SplitNode ID.
	 */
	readonly getGroupRef: (
		splitNodeId: string
	) => GroupImperativeHandle | null | undefined;
	/**
	 * Register a panel group's imperative handle.
	 * Called by SplitPanelRenderer on mount.
	 */
	readonly registerGroupRef: (
		splitNodeId: string,
		handle: GroupImperativeHandle | null
	) => void;
	/**
	 * Unregister a panel group's imperative handle.
	 * Called by SplitPanelRenderer on unmount.
	 */
	readonly unregisterGroupRef: (splitNodeId: string) => void;
}

const PanelGroupRegistryContext = createContext<PanelGroupRegistryValue | null>(
	null
);

/**
 * Provider that maintains a map of SplitNode ID → GroupImperativeHandle.
 */
function PanelGroupRegistryProvider({
	children,
}: {
	readonly children: React.ReactNode;
}) {
	const registryRef = useRef<Map<string, GroupImperativeHandle | null>>(
		new Map()
	);

	const registerGroupRef = useCallback(
		(splitNodeId: string, handle: GroupImperativeHandle | null) => {
			registryRef.current.set(splitNodeId, handle);
		},
		[]
	);

	const unregisterGroupRef = useCallback((splitNodeId: string) => {
		registryRef.current.delete(splitNodeId);
	}, []);

	const getGroupRef = useCallback(
		(splitNodeId: string): GroupImperativeHandle | null | undefined => {
			return registryRef.current.get(splitNodeId);
		},
		[]
	);

	return (
		<PanelGroupRegistryContext.Provider
			value={{ getGroupRef, registerGroupRef, unregisterGroupRef }}
		>
			{children}
		</PanelGroupRegistryContext.Provider>
	);
}

/**
 * Hook to access the panel group registry.
 * Returns null if no PanelGroupRegistryProvider is present.
 */
function usePanelGroupRegistry(): PanelGroupRegistryValue | null {
	return useContext(PanelGroupRegistryContext);
}

export { PanelGroupRegistryProvider, usePanelGroupRegistry };
