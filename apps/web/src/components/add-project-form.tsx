/**
 * Add Project button component.
 *
 * Opens the native OS folder picker (via Tauri dialog plugin), then calls the
 * `project.add` mutation with the selected directory path.
 *
 * Success: project appears in the list (via LiveStore), toast shown.
 * Error: server validation error displayed in a toast.
 *
 * @see Issue #27: Add Project form
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { Button } from "@/components/ui/button";
import { extractErrorMessage } from "@/lib/utils";

const addProjectMutation = LaborerClient.mutation("project.add");

function AddProjectForm() {
	const [isAdding, setIsAdding] = useState(false);
	const addProject = useAtomSet(addProjectMutation, { mode: "promise" });

	const handleClick = async () => {
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: "Select a git repository",
			});

			if (!selected) {
				return;
			}

			setIsAdding(true);

			const result = await addProject({
				payload: { repoPath: selected },
			});
			toast.success(`Project "${result.name}" added`);
		} catch (error: unknown) {
			const message = extractErrorMessage(error);
			toast.error(message);
		} finally {
			setIsAdding(false);
		}
	};

	return (
		<Button
			disabled={isAdding}
			onClick={handleClick}
			size="sm"
			variant="outline"
		>
			<FolderPlus className="size-3.5" />
			{isAdding ? "Adding..." : "Add Project"}
		</Button>
	);
}

export { AddProjectForm };
