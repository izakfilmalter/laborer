/**
 * Terminal list UI component per workspace.
 *
 * Displays all terminals for a given workspace from LiveStore. Each terminal
 * shows its command and status. Includes a "New Terminal" button that spawns
 * a new terminal via the terminal.spawn RPC mutation. Selecting a terminal
 * switches the active pane to display it.
 *
 * @see Issue #63: Terminal list per workspace UI
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { terminals } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { Plus, Square, Terminal as TerminalIcon } from "lucide-react";
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
					onSelect={handleSelectTerminal}
					terminal={terminal}
				/>
			))}
		</div>
	);
}

interface TerminalItemProps {
	readonly onKill: (terminalId: string) => void;
	readonly onSelect: (terminalId: string) => void;
	readonly terminal: {
		readonly id: string;
		readonly workspaceId: string;
		readonly command: string;
		readonly status: string;
		readonly ptySessionRef: string | null;
	};
}

function TerminalItem({ terminal, onSelect, onKill }: TerminalItemProps) {
	const isRunning = terminal.status === "running";

	return (
		<button
			className={cn(
				"flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
				"hover:bg-accent hover:text-accent-foreground",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			)}
			onClick={() => onSelect(terminal.id)}
			type="button"
		>
			<TerminalIcon
				className={cn(
					"size-3.5 shrink-0",
					isRunning ? "text-green-500" : "text-muted-foreground"
				)}
			/>
			<span className="min-w-0 flex-1 truncate font-mono">
				{terminal.command || "shell"}
			</span>
			<Badge
				className={cn(
					"shrink-0 border text-[10px] leading-none",
					isRunning
						? "border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400"
						: "border-muted-foreground/30 bg-muted text-muted-foreground"
				)}
				variant="outline"
			>
				{terminal.status}
			</Badge>
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
		</button>
	);
}

export { TerminalList };
