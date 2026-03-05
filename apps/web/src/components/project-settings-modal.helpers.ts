interface SetupScriptItem {
	readonly id: string;
	readonly value: string;
}

interface ResolvedConfigSnapshot {
	readonly rlphConfig: string | null;
	readonly setupScripts: readonly string[];
	readonly worktreeDir: string;
}

interface ConfigUpdates {
	rlphConfig?: string;
	setupScripts?: string[];
	worktreeDir?: string;
}

const normalizeSetupScripts = (
	setupScripts: readonly SetupScriptItem[]
): string[] =>
	setupScripts
		.map((script) => script.value.trim())
		.filter((script) => script.length > 0);

const areStringArraysEqual = (
	a: readonly string[],
	b: readonly string[]
): boolean => {
	if (a.length !== b.length) {
		return false;
	}

	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}

	return true;
};

const buildConfigUpdates = ({
	rlphConfig,
	resolvedConfig,
	setupScripts,
	worktreeDir,
}: {
	rlphConfig: string;
	resolvedConfig: ResolvedConfigSnapshot;
	setupScripts: readonly SetupScriptItem[];
	worktreeDir: string;
}): ConfigUpdates => {
	const updates: ConfigUpdates = {};

	const normalizedWorktreeDir = worktreeDir.trim();
	const normalizedSetupScripts = normalizeSetupScripts(setupScripts);
	const normalizedRlphConfig = rlphConfig.trim();

	if (
		normalizedWorktreeDir.length > 0 &&
		normalizedWorktreeDir !== resolvedConfig.worktreeDir
	) {
		updates.worktreeDir = normalizedWorktreeDir;
	}

	if (
		!areStringArraysEqual(normalizedSetupScripts, resolvedConfig.setupScripts)
	) {
		updates.setupScripts = normalizedSetupScripts;
	}

	if (
		normalizedRlphConfig.length > 0 &&
		normalizedRlphConfig !== (resolvedConfig.rlphConfig ?? "")
	) {
		updates.rlphConfig = normalizedRlphConfig;
	}

	return updates;
};

const getSettingsLoadErrorMessage = (message: string): string => {
	const lowercaseMessage = message.toLowerCase();
	if (
		lowercaseMessage.includes("parse") &&
		lowercaseMessage.includes("laborer.json")
	) {
		return "Could not read laborer.json. Fix the JSON syntax and reopen project settings.";
	}

	return "Failed to load project settings.";
};

export {
	areStringArraysEqual,
	buildConfigUpdates,
	getSettingsLoadErrorMessage,
	normalizeSetupScripts,
};
export type { ResolvedConfigSnapshot, SetupScriptItem };
