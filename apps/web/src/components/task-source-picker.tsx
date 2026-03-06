import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { Github, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { CreateTaskForm } from "@/components/create-task-form";
import {
	canImportTasks,
	isImportSource,
	type TaskSourceFilter,
} from "@/components/task-source-picker.helpers";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { extractErrorMessage } from "@/lib/utils";

const importGithubMutation = LaborerClient.mutation("task.importGithub");
const importLinearMutation = LaborerClient.mutation("task.importLinear");

interface TaskSourcePickerProps {
	readonly activeSource: TaskSourceFilter;
	readonly onSourceChange: (source: TaskSourceFilter) => void;
	readonly projectId: string;
}

function getImportLabel(source: Exclude<TaskSourceFilter, "manual">): string {
	return source === "github" ? "GitHub issues" : "Linear tasks";
}

function TaskSourcePicker({
	projectId,
	activeSource,
	onSourceChange,
}: TaskSourcePickerProps) {
	const importGithub = useAtomSet(importGithubMutation, {
		mode: "promise",
	});
	const importLinear = useAtomSet(importLinearMutation, {
		mode: "promise",
	});
	const [isImporting, setIsImporting] = useState(false);
	const hasAutoImportedRef = useRef<string | null>(null);

	const runImport = useCallback(
		async (source: Exclude<TaskSourceFilter, "manual">) => {
			if (!projectId) {
				return;
			}

			setIsImporting(true);

			try {
				const response =
					source === "github"
						? await importGithub({
								payload: { projectId },
							})
						: await importLinear({
								payload: { projectId },
							});

				const label = getImportLabel(source);
				if (response.importedCount === 0) {
					toast.success(`No new ${label.toLowerCase()} found`);
				} else {
					toast.success(
						`Imported ${response.importedCount} of ${response.totalCount} ${label.toLowerCase()}`
					);
				}
			} catch (error: unknown) {
				toast.error(extractErrorMessage(error));
			} finally {
				setIsImporting(false);
			}
		},
		[projectId, importGithub, importLinear]
	);

	useEffect(() => {
		if (
			!(canImportTasks(activeSource, projectId) && isImportSource(activeSource))
		) {
			hasAutoImportedRef.current = null;
			return;
		}

		const autoImportKey = `${activeSource}:${projectId}`;
		if (hasAutoImportedRef.current === autoImportKey) {
			return;
		}

		hasAutoImportedRef.current = autoImportKey;
		runImport(activeSource).catch(() => {
			// Errors are surfaced inside runImport.
		});
	}, [projectId, activeSource, runImport]);

	return (
		<div className="grid gap-2">
			<div className="flex items-center justify-between gap-2">
				<Tabs
					className="min-w-0 flex-1"
					onValueChange={(value) => onSourceChange(value as TaskSourceFilter)}
					value={activeSource}
				>
					<TabsList className="w-full" variant="line">
						<TabsTrigger className="flex-1" value="manual">
							Manual
						</TabsTrigger>
						<TabsTrigger className="flex-1" value="linear">
							Linear
						</TabsTrigger>
						<TabsTrigger className="flex-1" value="github">
							<Github className="size-3" />
							GitHub
						</TabsTrigger>
					</TabsList>
				</Tabs>

				{activeSource === "manual" ? (
					<CreateTaskForm defaultProjectId={projectId} />
				) : (
					<Button
						disabled={isImporting}
						onClick={() => {
							runImport(activeSource).catch(() => {
								// Errors are surfaced inside runImport.
							});
						}}
						size="sm"
						variant="outline"
					>
						{isImporting ? <Loader2 className="size-3.5 animate-spin" /> : null}
						Sync
					</Button>
				)}
			</div>
		</div>
	);
}

export { TaskSourcePicker };
