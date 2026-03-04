/**
 * Create Workspace form component.
 *
 * A dialog with a TanStack Form for creating a new workspace.
 * Fields: project selector (required), optional branch name.
 * On submit, calls the `workspace.create` mutation via AtomRpc.
 * Success: workspace appears in the list (via LiveStore), form resets, dialog closes.
 * Error: server validation error displayed via toast.
 *
 * @see Issue #42: Create Workspace form
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { projects } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { useForm } from "@tanstack/react-form";
import { Layers } from "lucide-react";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { extractErrorMessage } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";

const allProjects$ = queryDb(projects, { label: "createWorkspaceProjects" });

const createWorkspaceMutation = LaborerClient.mutation("workspace.create");

function CreateWorkspaceForm() {
	const [open, setOpen] = useState(false);
	const createWorkspace = useAtomSet(createWorkspaceMutation, {
		mode: "promise",
	});
	const store = useLaborerStore();
	const projectList = store.useQuery(allProjects$);

	const form = useForm({
		defaultValues: {
			projectId: "",
			branchName: "",
		},
		onSubmit: async ({ value }) => {
			try {
				const result = await createWorkspace({
					payload: {
						projectId: value.projectId,
						...(value.branchName.trim()
							? { branchName: value.branchName.trim() }
							: {}),
					},
				});
				toast.success(
					`Workspace created on branch "${result.branchName}" (port ${result.port})`
				);
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
				<Layers className="size-3.5" />
				Create Workspace
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create Workspace</DialogTitle>
					<DialogDescription>
						Create an isolated git worktree for an agent or task. Each workspace
						gets its own branch, port, and directory.
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
							name="projectId"
							validators={{
								onChange: ({ value }) => {
									if (!value) {
										return "Project is required";
									}
									return undefined;
								},
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0}>
									<FieldLabel>Project</FieldLabel>
									<Select
										onValueChange={(value) => {
											if (value !== null) {
												field.handleChange(value);
											}
										}}
										required
										value={field.state.value || null}
									>
										<SelectTrigger className="w-full">
											<SelectValue placeholder="Select a project" />
										</SelectTrigger>
										<SelectContent>
											{projectList.map((project) => (
												<SelectItem key={project.id} value={project.id}>
													{project.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FieldDescription>
										The project repository to create a workspace in.
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

						<form.Field name="branchName">
							{(field) => (
								<Field>
									<FieldLabel htmlFor="branchName">
										Branch Name (optional)
									</FieldLabel>
									<Input
										id="branchName"
										name={field.name}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="laborer/my-feature"
										value={field.state.value}
									/>
									<FieldDescription>
										Leave empty to auto-generate a branch name.
									</FieldDescription>
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
									{isSubmitting ? "Creating..." : "Create Workspace"}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export { CreateWorkspaceForm };
