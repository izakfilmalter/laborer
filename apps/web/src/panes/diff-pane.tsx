/**
 * Diff viewer pane component — renders git diff output using @pierre/diffs.
 *
 * Subscribes to the `diffs` table in LiveStore for the given workspace ID.
 * When the DiffService on the server polls `git diff` and commits a
 * `DiffUpdated` event, the reactive query re-fires and the component
 * re-renders with the new diff content.
 *
 * ## Live update architecture (Issue #89)
 *
 * The diff viewer updates **live** without any manual refresh:
 *
 * 1. Server DiffService polls `git diff` on a 2-second interval (Issue #83)
 * 2. DiffUpdated events are committed to LiveStore only when content changes
 *    (deduplication — Issue #84)
 * 3. Events sync to the client via WebSocket (LiveStore sync — Issue #18)
 * 4. This component reads the materialized `diffs` table row via reactive query
 * 5. `useTransition` defers the re-render of the PatchDiff component so large
 *    diffs don't block the UI thread (keeps the app responsive during updates)
 * 6. Scroll position is preserved across updates via a ref on the container div,
 *    so the user doesn't lose their place when the diff changes
 * 7. A brief "Updated" flash indicator appears in the top-right corner when
 *    new diff content arrives, then fades out after 1.5 seconds
 * 8. The `lastUpdated` timestamp is displayed at the bottom of the diff
 *
 * @see packages/server/src/services/diff-service.ts
 * @see packages/shared/src/schema.ts (diffs table, DiffUpdated event)
 * @see Issue #87: Diff viewer pane — render with @pierre/diffs
 * @see Issue #89: Diff viewer — live update
 */

import { diffs } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { FileCode2, RefreshCw } from "lucide-react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useTransition,
} from "react";
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

/**
 * Stable FileDiff options object — defined at module level to avoid
 * recreating on every render. FileDiff's internal rendering is expensive
 * (shiki syntax highlighting, hunk parsing), so stable options prevent
 * unnecessary re-processing.
 */
const FILE_DIFF_OPTIONS = {
	diffStyle: "split" as const,
	theme: { dark: "pierre-dark" as const, light: "pierre-light" as const },
	themeType: "dark" as const,
	diffIndicators: "bars" as const,
	lineDiffType: "word-alt" as const,
	overflow: "scroll" as const,
};

/** Duration (ms) to show the "Updated" flash indicator. */
const UPDATE_FLASH_DURATION = 1500;

interface DiffPaneProps {
	/** The workspace ID to display diffs for. */
	readonly workspaceId: string;
}

/**
 * Formats an ISO timestamp to a locale-appropriate relative time string.
 * Returns "just now" for timestamps within 10 seconds, otherwise a
 * human-readable time string (e.g., "2:34:56 PM").
 */
function formatLastUpdated(isoTimestamp: string): string {
	const date = new Date(isoTimestamp);
	const now = Date.now();
	const diffMs = now - date.getTime();
	if (diffMs < 10_000) {
		return "just now";
	}
	return date.toLocaleTimeString();
}

/**
 * DiffPane renders a live diff viewer for a given workspace.
 *
 * It subscribes to the LiveStore `diffs` table and filters by workspace ID.
 * When the server's DiffService detects file changes (via `git diff` polling),
 * it commits DiffUpdated events which sync to the client and trigger a
 * re-render with the new diff content.
 *
 * The raw git diff is parsed via `parsePatchFiles` into per-file metadata,
 * then each file is rendered with `FileDiff` from @pierre/diffs. This
 * supports multi-file diffs (PatchDiff only handles single-file patches).
 *
 * Live updates are smooth: `useTransition` prevents UI blocking during
 * large diff re-renders, scroll position is preserved across updates,
 * and a brief flash indicator shows when new content arrives.
 */
function DiffPane({ workspaceId }: DiffPaneProps) {
	const store = useLaborerStore();
	const diffRows = store.useQuery(allDiffs$);

	// --- Derive diff content and metadata from the reactive query ---
	const diffRow = useMemo(() => {
		return (
			diffRows.find(
				(r: { workspaceId: string }) => r.workspaceId === workspaceId
			) ?? null
		);
	}, [diffRows, workspaceId]);

	const diffContent = diffRow?.diffContent ?? "";
	const lastUpdated = diffRow?.lastUpdated ?? "";

	// --- Parse the raw git diff into per-file diff metadata ---
	// parsePatchFiles handles multi-file diffs correctly, returning an array
	// of ParsedPatch objects, each with a .files array of FileDiffMetadata.
	// PatchDiff only supports single-file patches and throws on multi-file input.
	const fileDiffs = useMemo(() => {
		if (!diffContent) {
			return [];
		}
		const parsed = parsePatchFiles(diffContent);
		return parsed.flatMap((p) => p.files);
	}, [diffContent]);

	// --- Deferred rendering via useTransition ---
	// FileDiff can be expensive to re-render for large diffs (shiki highlighting,
	// hunk parsing, DOM diffing). useTransition marks the re-render as non-urgent
	// so it doesn't block user interactions (scrolling, typing in terminals, etc.).
	const [isPending, startTransition] = useTransition();
	const [deferredFileDiffs, setDeferredFileDiffs] = useState(fileDiffs);

	useEffect(() => {
		startTransition(() => {
			setDeferredFileDiffs(fileDiffs);
		});
	}, [fileDiffs]);

	// --- Scroll position preservation ---
	// The onScroll handler (below) continuously saves the current scroll position
	// to savedScrollRef. After PatchDiff re-renders with new content, we use a
	// MutationObserver on the scroll container to detect DOM changes and restore
	// the scroll position. This prevents the user from losing their place when
	// the diff content changes underneath them.
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const savedScrollRef = useRef({ top: 0, left: 0 });

	useEffect(() => {
		const container = scrollContainerRef.current;
		if (!container) {
			return;
		}

		const observer = new MutationObserver(() => {
			// Restore scroll position after PatchDiff mutates the DOM
			container.scrollTop = savedScrollRef.current.top;
			container.scrollLeft = savedScrollRef.current.left;
		});

		observer.observe(container, { childList: true, subtree: true });

		return () => observer.disconnect();
	}, []);

	// --- "Updated" flash indicator ---
	// Shows a brief flash when new diff content arrives, then fades out.
	// Tracks the previous content to detect actual changes (not initial mount).
	const [showUpdateFlash, setShowUpdateFlash] = useState(false);
	const prevContentRef = useRef(diffContent);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		// Only flash on content *changes* (not initial mount or same content)
		if (
			prevContentRef.current !== "" &&
			diffContent !== prevContentRef.current &&
			diffContent !== ""
		) {
			setShowUpdateFlash(true);
			// Clear any existing timer before setting a new one
			if (flashTimerRef.current) {
				clearTimeout(flashTimerRef.current);
			}
			flashTimerRef.current = setTimeout(() => {
				setShowUpdateFlash(false);
			}, UPDATE_FLASH_DURATION);
		}
		prevContentRef.current = diffContent;
	}, [diffContent]);

	// Cleanup flash timer on unmount
	useEffect(() => {
		return () => {
			if (flashTimerRef.current) {
				clearTimeout(flashTimerRef.current);
			}
		};
	}, []);

	// --- Scroll event handler to keep savedScrollRef in sync ---
	const handleScroll = useCallback(() => {
		const container = scrollContainerRef.current;
		if (container) {
			savedScrollRef.current = {
				top: container.scrollTop,
				left: container.scrollLeft,
			};
		}
	}, []);

	// --- Empty state ---
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
		<div className="relative flex h-full w-full flex-col bg-background">
			{/* Update flash indicator — fades in/out when new diff content arrives */}
			{showUpdateFlash && (
				<div className="fade-in absolute top-2 right-2 z-10 flex animate-in items-center gap-1.5 rounded-md bg-primary/10 px-2 py-1 text-primary text-xs duration-200">
					<RefreshCw className="h-3 w-3" />
					Updated
				</div>
			)}

			{/* Pending indicator — shows when a large diff is being processed */}
			{isPending && (
				<div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 rounded-md bg-muted/90 px-2 py-1 text-muted-foreground text-xs backdrop-blur-sm">
					<RefreshCw className="h-3 w-3 animate-spin" />
					Updating...
				</div>
			)}

			{/* Scrollable diff content — ref preserves scroll position across updates */}
			<div
				className="min-h-0 flex-1 overflow-auto"
				onScroll={handleScroll}
				ref={scrollContainerRef}
			>
				{deferredFileDiffs.map((fileDiffMeta, index) => (
					<FileDiff
						fileDiff={fileDiffMeta}
						key={fileDiffMeta.name ?? index}
						options={FILE_DIFF_OPTIONS}
					/>
				))}
			</div>

			{/* Last updated timestamp footer */}
			{lastUpdated && (
				<div className="flex-none border-border border-t bg-muted/50 px-3 py-1 text-muted-foreground text-xs">
					Last updated: {formatLastUpdated(lastUpdated)}
				</div>
			)}
		</div>
	);
}

export { DiffPane };
