/**
 * Create Task form component.
 *
 * A dialog with a TanStack Form for creating a new manual task.
 * Fields: project selector (required), title (required), description (optional).
 * On submit, calls the `task.create` mutation via AtomRpc.
 * Success: task appears in the task list (via LiveStore), form resets, dialog closes.
 * Error: server validation error displayed via toast.
 *
 * @see Issue #103: Create Task form UI
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { projects } from "@laborer/shared/schema";
import { queryDb } from "@livestore/livestore";
import { useForm } from "@tanstack/react-form";
import { ClipboardPlus } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { extractErrorMessage } from "@/lib/utils";
import { useLaborerStore } from "@/livestore/store";

const allProjects$ = queryDb(projects, { label: "createTaskProjects" });

const createTaskMutation = LaborerClient.mutation("task.create");

function CreateTaskForm() {
	const [open, setOpen] = useState(false);
	const createTask = useAtomSet(createTaskMutation, {
		mode: "promise",
	});
	const store = useLaborerStore();
	const projectList = store.useQuery(allProjects$);

	const form = useForm({
		defaultValues: {
			projectId: "",
			title: "",
			description: "",
		},
		onSubmit: async ({ value }) => {
			try {
				await createTask({
					payload: {
						projectId: value.projectId,
						title: value.title.trim(),
						...(value.description.trim()
							? { description: value.description.trim() }
							: {}),
					},
				});
				toast.success(`Task "${value.title.trim()}" created`);
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
				<ClipboardPlus className="size-3.5" />
				Add Task
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create Task</DialogTitle>
					<DialogDescription>
						Create a manual task to track work. Tasks can drive workspace
						creation and help organize your development workflow.
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
										The project this task belongs to.
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

						<form.Field
							name="title"
							validators={{
								onChange: ({ value }) => {
									if (!value.trim()) {
										return "Title is required";
									}
									return undefined;
								},
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0}>
									<FieldLabel htmlFor="taskTitle">Title</FieldLabel>
									<Input
										id="taskTitle"
										name={field.name}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="Implement user authentication"
										value={field.state.value}
									/>
									<FieldDescription>
										A short, descriptive title for the task.
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

						<form.Field name="description">
							{(field) => (
								<Field>
									<FieldLabel htmlFor="taskDescription">
										Description (optional)
									</FieldLabel>
									<Textarea
										id="taskDescription"
										name={field.name}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="Additional details about what needs to be done..."
										rows={3}
										value={field.state.value}
									/>
									<FieldDescription>
										Optional additional context for the task.
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
									{isSubmitting ? "Creating..." : "Create Task"}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export { CreateTaskForm };
