import { useAtomSet, useAtomValue } from "@effect-atom/atom-react/Hooks";
import { Plus, Settings, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
	FieldLabel,
	FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { extractErrorMessage } from "@/lib/utils";

const updateConfigMutation = LaborerClient.mutation("config.update");

interface ProjectSettingsModalProps {
	readonly projectId: string;
	readonly projectName: string;
}

interface SetupScriptItem {
	readonly id: string;
	readonly value: string;
}

const toSetupScriptItems = (scripts: readonly string[]): SetupScriptItem[] =>
	scripts.map((script) => ({
		id: globalThis.crypto.randomUUID(),
		value: script,
	}));

function areStringArraysEqual(
	a: readonly string[],
	b: readonly string[]
): boolean {
	if (a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}

	return true;
}

function ProjectSettingsForm({
	projectId,
	projectName,
	onSaved,
}: {
	readonly projectId: string;
	readonly projectName: string;
	readonly onSaved: () => void;
}) {
	const configGet$ = useMemo(
		() => LaborerClient.query("config.get", { projectId }),
		[projectId]
	);
	const configResult = useAtomValue(configGet$);
	const updateConfig = useAtomSet(updateConfigMutation, { mode: "promise" });

	const [worktreeDir, setWorktreeDir] = useState("");
	const [setupScripts, setSetupScripts] = useState<SetupScriptItem[]>([]);
	const [rlphConfig, setRlphConfig] = useState("");
	const [initialized, setInitialized] = useState(false);
	const [isSaving, setIsSaving] = useState(false);

	useEffect(() => {
		if (configResult._tag !== "Success" || initialized) {
			return;
		}

		setWorktreeDir(configResult.value.worktreeDir.value);
		setSetupScripts(toSetupScriptItems(configResult.value.setupScripts.value));
		setRlphConfig(configResult.value.rlphConfig.value ?? "");
		setInitialized(true);
	}, [configResult, initialized]);

	if (
		configResult._tag !== "Success" &&
		(configResult._tag === "Initial" || configResult.waiting)
	) {
		return (
			<div className="flex items-center gap-2 py-6 text-muted-foreground text-sm">
				<Spinner className="size-4" />
				Loading project settings...
			</div>
		);
	}

	if (configResult._tag === "Failure") {
		return (
			<div className="py-4 text-destructive text-sm">
				Failed to load settings.
			</div>
		);
	}

	if (configResult._tag !== "Success") {
		return null;
	}

	const resolvedConfig = configResult.value;

	const handleSave = async () => {
		const updates: {
			rlphConfig?: string;
			setupScripts?: string[];
			worktreeDir?: string;
		} = {};

		const normalizedWorktreeDir = worktreeDir.trim();
		const normalizedSetupScripts = setupScripts
			.map((script) => script.value.trim())
			.filter((script) => script.length > 0);
		const normalizedRlphConfig = rlphConfig.trim();

		if (
			normalizedWorktreeDir.length > 0 &&
			normalizedWorktreeDir !== resolvedConfig.worktreeDir.value
		) {
			updates.worktreeDir = normalizedWorktreeDir;
		}

		if (
			!areStringArraysEqual(
				normalizedSetupScripts,
				resolvedConfig.setupScripts.value
			)
		) {
			updates.setupScripts = normalizedSetupScripts;
		}

		if (
			normalizedRlphConfig.length > 0 &&
			normalizedRlphConfig !== (resolvedConfig.rlphConfig.value ?? "")
		) {
			updates.rlphConfig = normalizedRlphConfig;
		}

		if (Object.keys(updates).length === 0) {
			toast.message("No config changes to save");
			return;
		}

		setIsSaving(true);
		try {
			await updateConfig({
				payload: {
					projectId,
					config: updates,
				},
			});
			toast.success(`Saved settings for ${projectName}`);
			onSaved();
		} catch (error: unknown) {
			toast.error(extractErrorMessage(error));
			setIsSaving(false);
		}
	};

	return (
		<>
			<div className="grid gap-4 py-2">
				<FieldSet>
					<Field>
						<FieldLabel htmlFor={`worktree-dir-${projectId}`}>
							Worktree directory
						</FieldLabel>
						<Input
							id={`worktree-dir-${projectId}`}
							onChange={(event) => setWorktreeDir(event.target.value)}
							placeholder={`~/.config/laborer/${projectName}`}
							value={worktreeDir}
						/>
						<FieldDescription className="text-xs">
							Resolved from: {resolvedConfig.worktreeDir.source}
						</FieldDescription>
					</Field>

					<Field>
						<FieldLabel>Setup scripts</FieldLabel>
						<div className="grid gap-2">
							{setupScripts.length === 0 && (
								<p className="text-muted-foreground text-xs">
									No setup scripts configured.
								</p>
							)}
							{setupScripts.map((script) => (
								<div className="flex items-center gap-2" key={script.id}>
									<Input
										onChange={(event) => {
											setSetupScripts((prev) => {
												return prev.map((item) => {
													if (item.id !== script.id) {
														return item;
													}

													return {
														...item,
														value: event.target.value,
													};
												});
											});
										}}
										placeholder="bun install"
										value={script.value}
									/>
									<Button
										aria-label="Remove setup script"
										onClick={() => {
											setSetupScripts((prev) =>
												prev.filter((item) => item.id !== script.id)
											);
										}}
										size="icon-sm"
										type="button"
										variant="ghost"
									>
										<Trash2 className="size-3.5 text-muted-foreground" />
									</Button>
								</div>
							))}
						</div>
						<div className="flex items-center justify-between">
							<FieldDescription className="text-xs">
								Resolved from: {resolvedConfig.setupScripts.source}
							</FieldDescription>
							<Button
								onClick={() => {
									setSetupScripts((prev) => [
										...prev,
										{ id: globalThis.crypto.randomUUID(), value: "" },
									]);
								}}
								size="sm"
								type="button"
								variant="outline"
							>
								<Plus className="size-3.5" />
								Add script
							</Button>
						</div>
					</Field>

					<Field>
						<FieldLabel htmlFor={`rlph-config-${projectId}`}>
							rlph config
						</FieldLabel>
						<Input
							id={`rlph-config-${projectId}`}
							onChange={(event) => setRlphConfig(event.target.value)}
							placeholder=".rlph/config.json"
							value={rlphConfig}
						/>
						<FieldDescription className="text-xs">
							Resolved from: {resolvedConfig.rlphConfig.source}
						</FieldDescription>
					</Field>
				</FieldSet>
			</div>
			<DialogFooter>
				<Button disabled={isSaving} onClick={handleSave} type="button">
					{isSaving && <Spinner className="size-3.5" />}
					{isSaving ? "Saving..." : "Save"}
				</Button>
			</DialogFooter>
		</>
	);
}

function ProjectSettingsModal({
	projectId,
	projectName,
}: ProjectSettingsModalProps) {
	const [open, setOpen] = useState(false);

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger
				render={
					<Button
						aria-label={`Open settings for ${projectName}`}
						size="icon-sm"
						variant="ghost"
					/>
				}
			>
				<Settings className="size-3.5 text-muted-foreground" />
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Project settings</DialogTitle>
					<DialogDescription>
						Configure worktree path, setup scripts, and rlph config for{" "}
						{projectName}.
					</DialogDescription>
				</DialogHeader>
				{open && (
					<ProjectSettingsForm
						onSaved={() => setOpen(false)}
						projectId={projectId}
						projectName={projectName}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

export { ProjectSettingsModal };
