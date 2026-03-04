/**
 * Add Project form component.
 *
 * A dialog with a TanStack Form for adding a new project by its repo path.
 * On submit, calls the `project.add` mutation via AtomRpc.
 * Success: project appears in the list (via LiveStore), form resets, dialog closes.
 * Error: server validation error displayed inline.
 *
 * @see Issue #27: Add Project form
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { useForm } from "@tanstack/react-form";
import { FolderPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LaborerClient } from "@/atoms/laborer-client";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * Extract a human-readable error message from an unknown error.
 * Handles Error instances and plain objects with a `message` property.
 */
function extractErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof (error as Record<string, unknown>).message === "string"
	) {
		return String((error as Record<string, unknown>).message);
	}
	return "Failed to add project";
}

const addProjectMutation = LaborerClient.mutation("project.add");

function AddProjectForm() {
	const [open, setOpen] = useState(false);
	const addProject = useAtomSet(addProjectMutation, { mode: "promise" });

	const form = useForm({
		defaultValues: {
			repoPath: "",
		},
		onSubmit: async ({ value }) => {
			try {
				const result = await addProject({
					payload: { repoPath: value.repoPath },
				});
				toast.success(`Project "${result.name}" added`);
				form.reset();
				setOpen(false);
			} catch (error: unknown) {
				const message = extractErrorMessage(error);
				toast.error(message);
			}
		},
	});

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				<FolderPlus className="size-3.5" />
				Add Project
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add Project</DialogTitle>
					<DialogDescription>
						Register a git repository as a project. Laborer will create isolated
						workspaces in this repo for your agents.
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						form.handleSubmit();
					}}
				>
					<div className="grid gap-4 py-2">
						<form.Field
							name="repoPath"
							validators={{
								onChange: ({ value }) => {
									if (!value.trim()) {
										return "Repository path is required";
									}
									return undefined;
								},
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0}>
									<FieldLabel htmlFor="repoPath">Repository Path</FieldLabel>
									<Input
										id="repoPath"
										name={field.name}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="/path/to/your/repo"
										value={field.state.value}
									/>
									<FieldDescription>
										Absolute path to a local git repository.
									</FieldDescription>
									{field.state.meta.isTouched &&
										field.state.meta.errors.length > 0 && (
											<FieldError>
												{field.state.meta.errors.join(", ")}
											</FieldError>
										)}
								</Field>
							)}
						</form.Field>
					</div>
					<DialogFooter>
						<form.Subscribe
							selector={(state) => [state.canSubmit, state.isSubmitting]}
						>
							{([canSubmit, isSubmitting]) => (
								<Button disabled={!canSubmit || isSubmitting} type="submit">
									{isSubmitting ? "Adding..." : "Add Project"}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export { AddProjectForm };
