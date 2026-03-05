/**
 * Terminal list UI component per workspace.
 *
 * Displays all terminals for a given workspace from LiveStore. Each terminal
 * shows its command and status. Includes a "New Terminal" button that spawns
 * a new terminal via the terminal.spawn RPC mutation. Selecting a terminal
 * switches the active pane to display it.
 *
 * Terminal items are draggable — users can drag a terminal from the sidebar
 * and drop it onto an empty panel pane to assign it to that specific pane.
 * The drag data carries `{ terminalId, workspaceId }` as JSON in the
 * `application/x-laborer-terminal` MIME type.
 *
 * @see Issue #63: Terminal list per workspace UI
 * @see Issue #134: Drag terminal from sidebar onto empty panel pane
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { terminals } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import {
	Plus,
	RotateCw,
	Square,
	Terminal as TerminalIcon,
	Trash2,
} from "lucide-react";
import type React from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, extractErrorMessage } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";
import { usePanelActions } from "@/panels/panel-context";

const allTerminals$ = queryDb(terminals, { label: "terminalList" });

const spawnTerminalMutation = LaborerClient.mutation("terminal.spawn");
const killTerminalMutation = LaborerClient.mutation("terminal.kill");
const removeTerminalMutation = LaborerClient.mutation("terminal.remove");
const restartTerminalMutation = LaborerClient.mutation("terminal.restart");

interface TerminalListProps {
	/** The workspace ID to filter terminals for. */
	readonly workspaceId: string;
}

/**
 * Terminal list for a single workspace.
 *
 * Shows all terminals belonging to the workspace, with a "New Terminal"
 * button and click-to-select behavior for switching the active panel pane.
 */
function TerminalList({ workspaceId }: TerminalListProps) {
	const store = useLaborerStore();
	const terminalList = store.useQuery(allTerminals$);
	const panelActions = usePanelActions();
	const spawnTerminal = useAtomSet(spawnTerminalMutation, {
		mode: "promise",
	});
	const killTerminal = useAtomSet(killTerminalMutation, {
		mode: "promise",
	});
	const removeTerminal = useAtomSet(removeTerminalMutation, {
		mode: "promise",
	});
	const restartTerminal = useAtomSet(restartTerminalMutation, {
		mode: "promise",
	});
	const [isSpawning, setIsSpawning] = useState(false);

	// Filter terminals for this workspace
	const workspaceTerminals = terminalList.filter(
		(t) => t.workspaceId === workspaceId
	);

	const handleSpawnTerminal = useCallback(async () => {
		setIsSpawning(true);
		try {
			const result = await spawnTerminal({
				payload: { workspaceId },
			});
			toast.success(`Terminal spawned: ${result.command}`);
			// Auto-assign the new terminal to a pane
			if (panelActions) {
				panelActions.assignTerminalToPane(result.id, workspaceId);
			}
		} catch (error) {
			toast.error(`Failed to spawn terminal: ${extractErrorMessage(error)}`);
		} finally {
			setIsSpawning(false);
		}
	}, [spawnTerminal, workspaceId, panelActions]);

	const handleKillTerminal = useCallback(
		async (terminalId: string) => {
			try {
				await killTerminal({
					payload: { terminalId },
				});
				toast.success("Terminal stopped");
			} catch (error) {
				toast.error(`Failed to stop terminal: ${extractErrorMessage(error)}`);
			}
		},
		[killTerminal]
	);

	const handleRemoveTerminal = useCallback(
		async (terminalId: string) => {
			try {
				await removeTerminal({
					payload: { terminalId },
				});
				toast.success("Terminal removed");
			} catch (error) {
				toast.error(`Failed to remove terminal: ${extractErrorMessage(error)}`);
			}
		},
		[removeTerminal]
	);

	const handleRestartTerminal = useCallback(
		async (terminalId: string) => {
			try {
				await restartTerminal({
					payload: { terminalId },
				});
				toast.success("Terminal restarted");
			} catch (error) {
				toast.error(
					`Failed to restart terminal: ${extractErrorMessage(error)}`
				);
			}
		},
		[restartTerminal]
	);

	const handleSelectTerminal = useCallback(
		(terminalId: string) => {
			if (panelActions) {
				panelActions.assignTerminalToPane(terminalId, workspaceId);
			}
		},
		[panelActions, workspaceId]
	);

	if (workspaceTerminals.length === 0) {
		return (
			<div className="flex items-center justify-between gap-2 py-1">
				<span className="text-muted-foreground text-xs">No terminals</span>
				<Button
					aria-label="New terminal"
					disabled={isSpawning}
					onClick={handleSpawnTerminal}
					size="xs"
					variant="outline"
				>
					<Plus className="size-3" />
					{isSpawning ? "Spawning..." : "New"}
				</Button>
			</div>
		);
	}

	return (
		<div className="grid gap-1">
			<div className="flex items-center justify-between gap-2">
				<span className="font-medium text-muted-foreground text-xs">
					Terminals ({workspaceTerminals.length})
				</span>
				<Button
					aria-label="New terminal"
					disabled={isSpawning}
					onClick={handleSpawnTerminal}
					size="xs"
					variant="outline"
				>
					<Plus className="size-3" />
					{isSpawning ? "Spawning..." : "New"}
				</Button>
			</div>
			{workspaceTerminals.map((terminal) => (
				<TerminalItem
					key={terminal.id}
					onKill={handleKillTerminal}
					onRemove={handleRemoveTerminal}
					onRestart={handleRestartTerminal}
					onSelect={handleSelectTerminal}
					terminal={terminal}
				/>
			))}
		</div>
	);
}

interface TerminalItemProps {
	readonly onKill: (terminalId: string) => void;
	readonly onRemove: (terminalId: string) => void;
	readonly onRestart: (terminalId: string) => void;
	readonly onSelect: (terminalId: string) => void;
	readonly terminal: {
		readonly id: string;
		readonly workspaceId: string;
		readonly command: string;
		readonly status: string;
		readonly ptySessionRef: string | null;
	};
}

/**
 * MIME type for terminal drag data. Using a custom MIME type ensures
 * only laborer drop targets accept the drag.
 */
const TERMINAL_DRAG_MIME = "application/x-laborer-terminal";

function TerminalItem({
	terminal,
	onSelect,
	onKill,
	onRemove,
	onRestart,
}: TerminalItemProps) {
	const isRunning = terminal.status === "running";

	const handleDragStart = useCallback(
		(e: React.DragEvent<HTMLButtonElement>) => {
			e.dataTransfer.setData(
				TERMINAL_DRAG_MIME,
				JSON.stringify({
					terminalId: terminal.id,
					workspaceId: terminal.workspaceId,
				})
			);
			e.dataTransfer.effectAllowed = "move";
		},
		[terminal.id, terminal.workspaceId]
	);

	return (
		<button
			className={cn(
				"flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
				"hover:bg-accent hover:text-accent-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				"cursor-grab active:cursor-grabbing"
			)}
			draggable
			onClick={() => onSelect(terminal.id)}
			onDragStart={handleDragStart}
			type="button"
		>
			<TerminalIcon
				className={cn(
					"size-3.5 shrink-0",
					isRunning ? "text-success" : "text-muted-foreground"
				)}
			/>
			<span className="min-w-0 flex-1 truncate font-mono">
				{terminal.command || "shell"}
			</span>
			<Badge
				className={cn(
					"shrink-0 border text-[10px] leading-none",
					isRunning
						? "border-success/30 bg-success/10 text-success"
						: "border-muted-foreground/30 bg-muted text-muted-foreground"
				)}
				variant="outline"
			>
				{terminal.status}
			</Badge>
			<Button
				aria-label="Restart terminal"
				className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
				onClick={(e) => {
					e.stopPropagation();
					onRestart(terminal.id);
				}}
				size="icon-sm"
				variant="ghost"
			>
				<RotateCw className="size-2.5" />
			</Button>
			{isRunning && (
				<Button
					aria-label="Stop terminal"
					className="size-5 shrink-0"
					onClick={(e) => {
						e.stopPropagation();
						onKill(terminal.id);
					}}
					size="icon-sm"
					variant="ghost"
				>
					<Square className="size-2.5" />
				</Button>
			)}
			{!isRunning && (
				<Button
					aria-label="Remove terminal"
					className="size-5 shrink-0 text-muted-foreground hover:text-destructive"
					onClick={(e) => {
						e.stopPropagation();
						onRemove(terminal.id);
					}}
					size="icon-sm"
					variant="ghost"
				>
					<Trash2 className="size-2.5" />
				</Button>
			)}
		</button>
	);
}

export { TerminalList };
