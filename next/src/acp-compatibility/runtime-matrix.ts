export const SUPPORTED_ACP_RUNTIME_MATRIX = {
  acpProtocol: 1,
  acpSdk: "1.3.0",
  bun: "1.3.5",
  chat: "4.37.0",
  chatSlackAdapter: "4.37.0",
  node: "24.11.1",
  openCodeCli: "0.0.0-next-17055",
  openCodeClient: "0.0.0-next-17055",
  slackWebApi: "8.0.0",
} as const;

export const ACP_COMPATIBILITY_DIAGNOSTIC_MAX_CHARACTERS = 2048;

interface Requirement {
  readonly expected: string;
  readonly path: readonly string[];
  readonly satisfiedBy: (value: unknown) => boolean;
}

const equals =
  (expected: unknown) =>
  (value: unknown): boolean =>
    value === expected;

const isAdvertisedCapability = (value: unknown): boolean =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requirements: readonly Requirement[] = [
  {
    expected: "1",
    path: ["protocolVersion"],
    satisfiedBy: equals(SUPPORTED_ACP_RUNTIME_MATRIX.acpProtocol),
  },
  {
    expected: '"OpenCode"',
    path: ["agentInfo", "name"],
    satisfiedBy: equals("OpenCode"),
  },
  {
    expected: `"${SUPPORTED_ACP_RUNTIME_MATRIX.openCodeCli}"`,
    path: ["agentInfo", "version"],
    satisfiedBy: equals(SUPPORTED_ACP_RUNTIME_MATRIX.openCodeCli),
  },
  {
    expected: "false",
    path: ["agentCapabilities", "loadSession"],
    satisfiedBy: equals(false),
  },
  ...Object.entries({ http: true, sse: false }).map(
    ([capability, supported]): Requirement => ({
      expected: String(supported),
      path: ["agentCapabilities", "mcpCapabilities", capability],
      satisfiedBy: equals(supported),
    })
  ),
  ...["embeddedContext", "image"].map(
    (capability): Requirement => ({
      expected: "true",
      path: ["agentCapabilities", "promptCapabilities", capability],
      satisfiedBy: equals(true),
    })
  ),
  ...["close", "list", "resume"].map(
    (capability): Requirement => ({
      expected: "an advertised capability object",
      path: ["agentCapabilities", "sessionCapabilities", capability],
      satisfiedBy: isAdvertisedCapability,
    })
  ),
];

const valueAtPath = (input: unknown, path: readonly string[]): unknown => {
  let current = input;
  for (const segment of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

const actualDescription = (value: unknown): string => {
  if (value === undefined) {
    return "missing";
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return `a string (${value.length} characters)`;
  }
  if (Array.isArray(value)) {
    return `an array (${value.length} items)`;
  }
  return typeof value;
};

export const assertSupportedOpenCodeInitialization = (input: unknown): void => {
  const failures = requirements.flatMap((requirement) => {
    const actual = valueAtPath(input, requirement.path);
    return requirement.satisfiedBy(actual)
      ? []
      : [
          `${requirement.path.join(".")}: expected ${requirement.expected}, received ${actualDescription(actual)}`,
        ];
  });
  if (failures.length === 0) {
    return;
  }
  const diagnostic = [
    `OpenCode ACP compatibility check failed for @opencode-ai/cli@${SUPPORTED_ACP_RUNTIME_MATRIX.openCodeCli}.`,
    ...failures.map((failure) => `- ${failure}`),
    "Reinstall with `bun install --frozen-lockfile`; if the failure remains, update next/docs/acp-runtime-matrix.md and its compatibility contract deliberately.",
  ].join("\n");
  throw new Error(
    diagnostic.slice(0, ACP_COMPATIBILITY_DIAGNOSTIC_MAX_CHARACTERS)
  );
};
