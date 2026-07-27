import type {
  Implementation,
  NewSessionResponse,
  ResumeSessionResponse,
  SessionConfigOption,
} from "@agentclientprotocol/sdk";
import { Array as EffectArray } from "effect";
import type { AcpAuthorityRepository } from "./acp-authority.ts";
import type { AcpConfigSourceInventory } from "./acp-config-source-inventory.ts";

const MAX_METADATA_VALUE_LENGTH = 256;
const MAX_ENVIRONMENT_NAMES = 64;
const MAX_MCP_SERVER_NAMES = 16;
export const ACP_INTEGRATION_CONTRACT_VERSION = 2;

export interface AcpEffectiveMetadata {
  readonly clientMcpServerNames: readonly string[];
  readonly configSourceInventory: AcpConfigSourceInventory;
  readonly cwd: string;
  readonly effort: string | null;
  readonly environmentAggregate: string;
  readonly environmentNameCount: number;
  readonly environmentNames: readonly string[];
  readonly environmentNamesIncomplete: boolean;
  readonly implementation: {
    readonly name: string;
    readonly version: string;
  };
  readonly integrationContractVersion: number;
  readonly mode: string | null;
  readonly model: string | null;
  readonly protocolVersion: number;
  readonly rootAuthority: "bound-project-root";
  readonly selectedAgent: string | null;
}

export interface SignedAcpEffectiveMetadata {
  readonly fingerprint: string;
  readonly metadata: AcpEffectiveMetadata;
}

const bounded = (value: string): string =>
  value.slice(0, MAX_METADATA_VALUE_LENGTH);

const boundedNames = (
  values: readonly string[],
  maximum: number
): readonly string[] =>
  [...new Set(values.filter((value) => value.length > 0).map(bounded))]
    .sort()
    .slice(0, maximum);

const currentStringValue = (
  options: readonly SessionConfigOption[] | null | undefined,
  predicate: (option: SessionConfigOption) => boolean
): string | null => {
  const option = options?.find(predicate);
  if (option === undefined || !("currentValue" in option)) {
    return null;
  }
  return typeof option.currentValue === "string"
    ? bounded(option.currentValue)
    : null;
};

export const extractAcpEffectiveMetadata = (options: {
  readonly agentInfo: Implementation | null | undefined;
  readonly configSourceInventory: AcpConfigSourceInventory;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly mcpServerNames: readonly string[];
  readonly protocolVersion: number;
  readonly repository: AcpAuthorityRepository;
  readonly response: NewSessionResponse | ResumeSessionResponse;
}): AcpEffectiveMetadata => {
  const configOptions = options.response.configOptions;
  const responseMode = options.response.modes?.currentModeId;
  const environmentEntries = Object.entries(options.environment)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([left], [right]) => left.localeCompare(right));
  const environmentNames = environmentEntries.map(([name]) => name);
  const selectedAgent =
    typeof responseMode === "string"
      ? bounded(responseMode)
      : currentStringValue(
          configOptions,
          (option) => option.category === "mode"
        );
  return {
    implementation: {
      name: bounded(options.agentInfo?.name ?? "unknown"),
      version: bounded(options.agentInfo?.version ?? "unknown"),
    },
    clientMcpServerNames: boundedNames(
      options.mcpServerNames,
      MAX_MCP_SERVER_NAMES
    ),
    configSourceInventory: options.configSourceInventory,
    cwd: bounded(options.cwd),
    environmentAggregate: options.repository.digest(
      "effective-acp-environment",
      JSON.stringify(environmentEntries)
    ),
    environmentNameCount: environmentNames.length,
    environmentNames: boundedNames(environmentNames, MAX_ENVIRONMENT_NAMES),
    environmentNamesIncomplete: environmentNames.length > MAX_ENVIRONMENT_NAMES,
    effort: currentStringValue(
      configOptions,
      (option) => option.category === "thought_level"
    ),
    integrationContractVersion: ACP_INTEGRATION_CONTRACT_VERSION,
    mode:
      typeof responseMode === "string" ? bounded(responseMode) : selectedAgent,
    model: currentStringValue(
      configOptions,
      (option) => option.category === "model"
    ),
    protocolVersion: options.protocolVersion,
    rootAuthority: "bound-project-root",
    selectedAgent,
  };
};

const canonicalMetadata = (metadata: AcpEffectiveMetadata): string =>
  JSON.stringify({
    implementation: metadata.implementation,
    clientMcpServerNames: EffectArray.fromIterable(
      metadata.clientMcpServerNames
    ),
    configSourceInventory: metadata.configSourceInventory,
    cwd: metadata.cwd,
    environmentAggregate: metadata.environmentAggregate,
    environmentNameCount: metadata.environmentNameCount,
    environmentNames: EffectArray.fromIterable(metadata.environmentNames),
    environmentNamesIncomplete: metadata.environmentNamesIncomplete,
    effort: metadata.effort,
    integrationContractVersion: metadata.integrationContractVersion,
    mode: metadata.mode,
    model: metadata.model,
    protocolVersion: metadata.protocolVersion,
    rootAuthority: metadata.rootAuthority,
    selectedAgent: metadata.selectedAgent,
  });

export const signAcpEffectiveMetadata = (
  repository: AcpAuthorityRepository,
  metadata: AcpEffectiveMetadata
): SignedAcpEffectiveMetadata => ({
  fingerprint: repository.digest(
    "effective-acp-metadata",
    canonicalMetadata(metadata)
  ),
  metadata,
});
