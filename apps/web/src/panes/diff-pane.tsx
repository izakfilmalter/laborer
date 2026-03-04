/**
 * Diff viewer pane component — renders git diff output using @pierre/diffs.
 *
 * Subscribes to the `diffs` table in LiveStore for the given workspace ID.
 * When the DiffService on the server polls `git diff` and commits a
 * `DiffUpdated` event, the reactive query re-fires and the component
 * re-renders with the new diff content.
 *
 * Architecture:
 * - Server DiffService polls `git diff` on a 2-second interval (Issue #83)
 * - DiffUpdated events are committed to LiveStore when content changes (Issue #84)
 * - Events sync to the client via WebSocket (LiveStore sync)
 * - This component reads the materialized `diffs` table row via reactive query
 * - @pierre/diffs PatchDiff component renders the raw git diff output
 *
 * @see packages/server/src/services/diff-service.ts
 * @see packages/shared/src/schema.ts (diffs table, DiffUpdated event)
 * @see Issue #87: Diff viewer pane — render with @pierre/diffs
 */

import { diffs } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { PatchDiff } from "@pierre/diffs/react";
import { FileCode2 } from "lucide-react";
import { useMemo } from "react";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { useLaborerStore } from "@/livestore/store";

/** Module-level query — shared across all DiffPane instances with the same label. */
const allDiffs$ = queryDb(diffs, { label: "diffPane" });

interface DiffPaneProps {
	/** The workspace ID to display diffs for. */
	readonly workspaceId: string;
}

/**
 * DiffPane renders a live diff viewer for a given workspace.
 *
 * It subscribes to the LiveStore `diffs` table and filters by workspace ID.
 * When the server's DiffService detects file changes (via `git diff` polling),
 * it commits DiffUpdated events which sync to the client and trigger a
 * re-render with the new diff content.
 *
 * The @pierre/diffs PatchDiff component handles parsing and rendering the
 * raw git diff output with syntax highlighting, split/unified views,
 * line numbers, and word-level diff highlighting.
 */
function DiffPane({ workspaceId }: DiffPaneProps) {
	const store = useLaborerStore();
	const diffRows = store.useQuery(allDiffs$);

	const diffContent = useMemo(() => {
		const row = diffRows.find(
			(r: { workspaceId: string }) => r.workspaceId === workspaceId
		);
		return row?.diffContent ?? "";
	}, [diffRows, workspaceId]);

	if (!diffContent) {
		return (
			<div className="flex h-full w-full items-center justify-center bg-background">
				<Empty>
					<EmptyHeader>
						<EmptyMedia variant="icon">
							<FileCode2 />
						</EmptyMedia>
						<EmptyTitle>No changes</EmptyTitle>
						<EmptyDescription>
							No file changes detected in this workspace. Changes will appear
							here automatically as the agent modifies files.
						</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</div>
		);
	}

	return (
		<div className="h-full w-full overflow-auto bg-background">
			<PatchDiff
				options={{
					diffStyle: "split",
					theme: { dark: "pierre-dark", light: "pierre-light" },
					themeType: "dark",
					diffIndicators: "bars",
					lineDiffType: "word-alt",
					overflow: "scroll",
				}}
				patch={diffContent}
			/>
		</div>
	);
}

export { DiffPane };
