/**
 * Write PRD form component.
 *
 * A dialog with a TanStack Form for writing a PRD in a workspace.
 * Fields: description textarea (required).
 * On submit, calls the `rlph.writePRD` mutation via AtomRpc, which
 * spawns a terminal running `rlph prd [description]` in the workspace.
 * The spawned terminal is auto-assigned to a panel pane so the user
 * immediately sees the rlph TUI output in xterm.js.
 *
 * @see Issue #95: PRD writing form + writePRD button
 * @see Issue #94: rlph.writePRD RPC handler
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { useForm } from "@tanstack/react-form";
import { FileText } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { extractErrorMessage } from "@/lib/utils";
import { usePanelActions } from "@/panels/panel-context";

const writePrdMutation = LaborerClient.mutation("rlph.writePRD");

interface WritePrdFormProps {
	readonly onTerminalSpawned?: () => void;
	readonly workspaceId: string;
}

function WritePrdForm({ workspaceId, onTerminalSpawned }: WritePrdFormProps) {
	const [open, setOpen] = useState(false);
	const writePrd = useAtomSet(writePrdMutation, { mode: "promise" });
	const panelActions = usePanelActions();

	const form = useForm({
		defaultValues: {
			description: "",
		},
		onSubmit: async ({ value }) => {
			try {
				const result = await writePrd({
					payload: {
						workspaceId,
						...(value.description.trim()
							? { description: value.description.trim() }
							: {}),
					},
				});
				toast.success("PRD writing started");
				// Auto-assign the spawned terminal to a pane
				if (panelActions) {
					panelActions.assignTerminalToPane(result.id, workspaceId);
				}
				form.reset();
				setOpen(false);
				onTerminalSpawned?.();
			} catch (error: unknown) {
				const message = extractErrorMessage(error);
				toast.error(`Failed to start PRD writing: ${message}`);
			}
		},
	});

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger
				render={
					<Button
						aria-label="Write PRD"
						size="icon-xs"
						title="Write PRD (rlph prd)"
						variant="ghost"
					/>
				}
			>
				<FileText className="size-3.5 text-blue-600 dark:text-blue-400" />
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Write PRD</DialogTitle>
					<DialogDescription>
						Describe what you want to build. This will run{" "}
						<code className="rounded bg-muted px-1 font-mono text-xs">
							rlph prd
						</code>{" "}
						in the workspace to generate a Product Requirements Document and
						create issues from it.
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
							name="description"
							validators={{
								onChange: ({ value }) => {
									if (!value.trim()) {
										return "Description is required";
									}
									return undefined;
								},
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0}>
									<FieldLabel>Description</FieldLabel>
									<Textarea
										name={field.name}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										placeholder="Describe the feature or product you want to build..."
										rows={6}
										value={field.state.value}
									/>
									<FieldDescription>
										A description of what you want the PRD to cover. This will
										be passed to rlph prd as the initial prompt.
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
									{isSubmitting ? "Starting..." : "Write PRD"}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export { WritePrdForm };
