/**
 * Review PR form component.
 *
 * A dialog with a TanStack Form for reviewing a pull request in a workspace.
 * Fields: PR number input (required, must be a positive integer).
 * On submit, calls the `rlph.review` mutation via AtomRpc, which
 * spawns a terminal running `rlph review <prNumber>` in the workspace.
 * The spawned terminal is auto-assigned to a panel pane so the user
 * immediately sees the rlph TUI output in xterm.js.
 *
 * @see Issue #97: "Review PR" button + PR number input
 * @see Issue #96: rlph.review RPC handler
 */

import { useAtomSet } from "@effect-atom/atom-react/Hooks";
import { useForm } from "@tanstack/react-form";
import { Eye } from "lucide-react";
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
import { extractErrorMessage } from "@/lib/utils";
import { usePanelActions } from "@/panels/panel-context";

const reviewPrMutation = LaborerClient.mutation("rlph.review");

interface ReviewPrFormProps {
	readonly onTerminalSpawned?: () => void;
	readonly workspaceId: string;
}

function ReviewPrForm({ workspaceId, onTerminalSpawned }: ReviewPrFormProps) {
	const [open, setOpen] = useState(false);
	const reviewPr = useAtomSet(reviewPrMutation, { mode: "promise" });
	const panelActions = usePanelActions();

	const form = useForm({
		defaultValues: {
			prNumber: "",
		},
		onSubmit: async ({ value }) => {
			try {
				const prNum = Number.parseInt(value.prNumber, 10);
				const result = await reviewPr({
					payload: {
						workspaceId,
						prNumber: prNum,
					},
				});
				toast.success(`Review started for PR #${prNum}`);
				// Auto-assign the spawned terminal to a pane
				if (panelActions) {
					panelActions.assignTerminalToPane(result.id, workspaceId);
				}
				form.reset();
				setOpen(false);
				onTerminalSpawned?.();
			} catch (error: unknown) {
				const message = extractErrorMessage(error);
				toast.error(`Failed to start PR review: ${message}`);
			}
		},
	});

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger
				render={
					<Button
						aria-label="Review PR"
						size="icon-xs"
						title="Review PR (rlph review)"
						variant="ghost"
					/>
				}
			>
				<Eye className="size-3.5 text-purple-600 dark:text-purple-400" />
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Review PR</DialogTitle>
					<DialogDescription>
						Enter the pull request number to review. This will run{" "}
						<code className="rounded bg-muted px-1 font-mono text-xs">
							rlph review &lt;pr&gt;
						</code>{" "}
						in the workspace to review the agent-produced code.
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
							name="prNumber"
							validators={{
								onChange: ({ value }) => {
									if (!value.trim()) {
										return "PR number is required";
									}
									const num = Number.parseInt(value, 10);
									if (Number.isNaN(num) || num <= 0) {
										return "PR number must be a positive integer";
									}
									if (!Number.isInteger(Number(value))) {
										return "PR number must be a whole number";
									}
									return undefined;
								},
							}}
						>
							{(field) => (
								<Field data-invalid={field.state.meta.errors.length > 0}>
									<FieldLabel>Pull Request Number</FieldLabel>
									<Input
										inputMode="numeric"
										name={field.name}
										onBlur={field.handleBlur}
										onChange={(e) => field.handleChange(e.target.value)}
										pattern="[0-9]*"
										placeholder="e.g. 42"
										type="text"
										value={field.state.value}
									/>
									<FieldDescription>
										The number of the pull request to review (e.g., from GitHub
										or the issue tracker).
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
									{isSubmitting ? "Starting..." : "Review PR"}
								</Button>
							)}
						</form.Subscribe>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

export { ReviewPrForm };
