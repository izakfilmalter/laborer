import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import {
  type Node as JsonNode,
  type ParseError,
  parseTree,
} from "jsonc-parser";
import { HandlerFailure } from "../prototype/errors.ts";
import type { AcpAuthorityRepository } from "./acp-authority.ts";

const MAX_CONFIG_SOURCE_DEPTH = 6;
const MAX_CONFIG_SOURCE_FILE_BYTES = 256 * 1024;
const MAX_CONFIG_SOURCE_FILES = 128;
const MAX_CONFIG_SOURCE_TOTAL_BYTES = 1024 * 1024;
const MAX_CONFIG_ANCESTOR_DEPTH = 32;
const MAX_CONFIG_DOCUMENT_DEPTH = 64;

export const AcpConfigSourceCategory = [
  "agent",
  "auth",
  "command",
  "config",
  "mcp",
  "other",
  "plugin",
  "skill",
  "tool",
] as const;
export type AcpConfigSourceCategory = (typeof AcpConfigSourceCategory)[number];

export interface AcpConfigSourceInventoryCategory {
  readonly category: AcpConfigSourceCategory;
  readonly fileCount: number;
  readonly totalBytes: number;
}

export interface AcpConfigSourceInventory {
  readonly categories: readonly AcpConfigSourceInventoryCategory[];
  readonly complete: boolean;
  readonly digest: string;
  readonly fileCount: number;
  readonly incompleteReasons: readonly string[];
  readonly totalBytes: number;
}

interface InventoryFile {
  readonly category: AcpConfigSourceCategory;
  readonly contentDigest: string;
  readonly relativePath: string;
  readonly scope: "global-auth" | "project" | "xdg-config";
  readonly size: number;
}

interface InventoryRoot {
  readonly includeLegacyConfig: boolean;
  readonly includeResources: boolean;
  readonly path: string;
  readonly scope: InventoryFile["scope"];
}

const inventoryFailure = (): HandlerFailure =>
  HandlerFailure.make({
    category: "protocol",
    safeDetail: "OpenCode configuration source inventory is unavailable",
  });

const collisionFailure = (detail: string): HandlerFailure =>
  HandlerFailure.make({ category: "protocol", safeDetail: detail });

const isMissing = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === "ENOENT";

const projectAncestors = (projectRoot: string): readonly string[] => {
  const ancestors: string[] = [];
  let current = resolve(projectRoot);
  for (let depth = 0; depth < MAX_CONFIG_ANCESTOR_DEPTH; depth += 1) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) {
      return ancestors.reverse();
    }
    current = parent;
  }
  throw new Error("OpenCode configuration ancestry exceeded its limit");
};

const configFilesIn = (
  directory: string,
  includeLegacyConfig: boolean
): readonly string[] =>
  (includeLegacyConfig
    ? ["config.json", "opencode.json", "opencode.jsonc"]
    : ["opencode.json", "opencode.jsonc"]
  ).map((name) => resolve(directory, name));

const nonEmptyEnvironmentValue = (
  value: string | undefined
): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

const effectiveConfigPaths = (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly projectRoot: string;
}): readonly string[] => {
  const paths: string[] = [];
  const disableProjectConfig =
    options.environment.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase();
  const projectConfigDisabled =
    disableProjectConfig === "true" || disableProjectConfig === "1";
  const ancestors = projectConfigDisabled
    ? []
    : projectAncestors(options.projectRoot);
  for (const ancestor of ancestors) {
    paths.push(...configFilesIn(ancestor, false));
    paths.push(...configFilesIn(resolve(ancestor, ".opencode"), false));
  }
  const systemHome =
    nonEmptyEnvironmentValue(options.environment.HOME) ?? homedir();
  const openCodeHome =
    nonEmptyEnvironmentValue(options.environment.OPENCODE_TEST_HOME) ??
    systemHome;
  const xdgConfigHome = nonEmptyEnvironmentValue(
    options.environment.XDG_CONFIG_HOME
  );
  let globalConfig: string | undefined;
  if (xdgConfigHome !== undefined) {
    globalConfig = resolve(xdgConfigHome, "opencode");
  } else {
    globalConfig = resolve(systemHome, ".config", "opencode");
  }
  if (globalConfig !== undefined) {
    paths.push(...configFilesIn(globalConfig, true));
  }
  paths.push(...configFilesIn(resolve(openCodeHome, ".opencode"), false));
  const customConfigDirectory = nonEmptyEnvironmentValue(
    options.environment.OPENCODE_CONFIG_DIR
  );
  if (customConfigDirectory !== undefined) {
    paths.push(
      ...configFilesIn(
        resolve(options.projectRoot, customConfigDirectory),
        false
      )
    );
  }
  const customConfig = nonEmptyEnvironmentValue(
    options.environment.OPENCODE_CONFIG
  );
  if (customConfig !== undefined) {
    paths.push(resolve(options.projectRoot, customConfig));
  }
  return [...new Set(paths)];
};

const assertBoundedJsonDepth = (root: JsonNode): void => {
  const pending: { readonly depth: number; readonly node: JsonNode }[] = [
    { depth: 0, node: root },
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    if (current.depth > MAX_CONFIG_DOCUMENT_DEPTH) {
      throw new Error("OpenCode configuration document is too deep");
    }
    for (const child of current.node.children ?? []) {
      pending.push({ depth: current.depth + 1, node: child });
    }
  }
};

const reservedMcpCollision = (
  source: string,
  names: ReadonlySet<string>
): boolean => {
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (root === undefined || errors.length > 0 || root.type !== "object") {
    throw new Error("OpenCode configuration document is invalid");
  }
  assertBoundedJsonDepth(root);
  for (const property of root.children ?? []) {
    const [key, value] = property.children ?? [];
    if (key?.value !== "mcp" || value?.type !== "object") {
      continue;
    }
    for (const serverProperty of value.children ?? []) {
      const serverName = serverProperty.children?.[0]?.value;
      if (typeof serverName === "string" && names.has(serverName)) {
        return true;
      }
    }
  }
  return false;
};

const readOptionalBoundedConfig = async (
  path: string
): Promise<string | null> => {
  try {
    const resolvedPath = resolve(path);
    const metadata = await lstat(resolvedPath);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_CONFIG_SOURCE_FILE_BYTES ||
      (await realpath(resolvedPath)) !== resolvedPath
    ) {
      throw new Error("OpenCode configuration source is unsafe");
    }
    const source = await readFile(resolvedPath, "utf8");
    if (Buffer.byteLength(source, "utf8") !== metadata.size) {
      throw new Error("OpenCode configuration source changed while reading");
    }
    return source;
  } catch (cause) {
    if (isMissing(cause)) {
      return null;
    }
    throw cause;
  }
};

export const preflightReservedMcpNames = Effect.fn("preflightReservedMcpNames")(
  function* (options: {
    readonly environment: NodeJS.ProcessEnv;
    readonly names: readonly string[];
    readonly projectRoot: string;
  }): Effect.fn.Return<void, HandlerFailure> {
    const names = new Set(options.names);
    if (
      names.size !== options.names.length ||
      [...names].some((name) => !name)
    ) {
      return yield* collisionFailure("Reserved MCP identity set is invalid");
    }
    const paths = yield* Effect.try({
      try: () =>
        effectiveConfigPaths({
          environment: options.environment,
          projectRoot: options.projectRoot,
        }),
      catch: () => collisionFailure("OpenCode configuration preflight failed"),
    });
    if (paths.length > MAX_CONFIG_SOURCE_FILES) {
      return yield* collisionFailure("OpenCode configuration preflight failed");
    }
    let totalBytes = 0;
    for (const path of paths) {
      const source = yield* Effect.tryPromise({
        try: () => readOptionalBoundedConfig(path),
        catch: () =>
          collisionFailure("OpenCode configuration preflight failed"),
      });
      if (source === null) {
        continue;
      }
      totalBytes += Buffer.byteLength(source, "utf8");
      if (totalBytes > MAX_CONFIG_SOURCE_TOTAL_BYTES) {
        return yield* collisionFailure(
          "OpenCode configuration preflight failed"
        );
      }
      const collides = yield* Effect.try({
        try: () => reservedMcpCollision(source, names),
        catch: () =>
          collisionFailure("OpenCode configuration preflight failed"),
      });
      if (collides) {
        return yield* collisionFailure(
          "Reserved MCP server name collides with user configuration"
        );
      }
    }
    const inlineConfig = nonEmptyEnvironmentValue(
      options.environment.OPENCODE_CONFIG_CONTENT
    );
    if (inlineConfig === undefined) {
      return;
    }
    const inlineBytes = Buffer.byteLength(inlineConfig, "utf8");
    if (
      inlineBytes > MAX_CONFIG_SOURCE_FILE_BYTES ||
      totalBytes + inlineBytes > MAX_CONFIG_SOURCE_TOTAL_BYTES
    ) {
      return yield* collisionFailure("OpenCode configuration preflight failed");
    }
    const inlineCollision = yield* Effect.try({
      try: () => reservedMcpCollision(inlineConfig, names),
      catch: () => collisionFailure("OpenCode configuration preflight failed"),
    });
    if (inlineCollision) {
      return yield* collisionFailure(
        "Reserved MCP server name collides with user configuration"
      );
    }
  }
);

const categoryFor = (relativePath: string): AcpConfigSourceCategory => {
  const normalized = relativePath.split(sep).join("/");
  const first = normalized.split("/")[0]?.toLowerCase() ?? "";
  if (
    normalized === "auth.json" ||
    normalized === "auth" ||
    normalized.endsWith("/auth.json")
  ) {
    return "auth";
  }
  if (
    normalized === "config.json" ||
    normalized === "opencode.json" ||
    normalized === "opencode.jsonc"
  ) {
    return "config";
  }
  switch (first) {
    case "agent":
    case "agents":
      return "agent";
    case "command":
    case "commands":
      return "command";
    case "config":
      return "config";
    case "mcp":
      return "mcp";
    case "plugin":
    case "plugins":
      return "plugin";
    case "skill":
    case "skills":
      return "skill";
    case "tool":
    case "tools":
      return "tool";
    default:
      return "other";
  }
};

const assertContained = (root: string, candidate: string): void => {
  const child = relative(root, candidate);
  if (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep))
  ) {
    return;
  }
  throw new Error("OpenCode configuration source escaped its authority root");
};

const recordFile = async (options: {
  readonly files: InventoryFile[];
  readonly incompleteReasons: Set<string>;
  readonly path: string;
  readonly relativePath: string;
  readonly root: InventoryRoot;
}): Promise<void> => {
  assertContained(options.root.path, options.path);
  const metadata = await lstat(options.path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("OpenCode configuration source is not a regular file");
  }
  if ((await realpath(options.path)) !== options.path) {
    throw new Error("OpenCode configuration source changed identity");
  }
  if (metadata.size > MAX_CONFIG_SOURCE_FILE_BYTES) {
    options.incompleteReasons.add("file-byte-limit");
    return;
  }
  if (options.files.length >= MAX_CONFIG_SOURCE_FILES) {
    options.incompleteReasons.add("file-count-limit");
    return;
  }
  const currentBytes = options.files.reduce(
    (total, file) => total + file.size,
    0
  );
  if (currentBytes + metadata.size > MAX_CONFIG_SOURCE_TOTAL_BYTES) {
    options.incompleteReasons.add("total-byte-limit");
    return;
  }
  const content = await readFile(options.path);
  if (content.byteLength !== metadata.size) {
    throw new Error("OpenCode configuration source changed while reading");
  }
  options.files.push({
    category: categoryFor(options.relativePath),
    contentDigest: createHash("sha256").update(content).digest("base64url"),
    relativePath: options.relativePath.split(sep).join("/"),
    scope: options.root.scope,
    size: content.byteLength,
  });
};

const scanDirectory = async (options: {
  readonly depth: number;
  readonly files: InventoryFile[];
  readonly incompleteReasons: Set<string>;
  readonly path: string;
  readonly relativePath: string;
  readonly root: InventoryRoot;
}): Promise<void> => {
  if (options.depth > MAX_CONFIG_SOURCE_DEPTH) {
    options.incompleteReasons.add("directory-depth-limit");
    return;
  }
  assertContained(options.root.path, options.path);
  const metadata = await lstat(options.path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("OpenCode configuration source directory is unsafe");
  }
  const entries = await readdir(options.path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }
    const path = resolve(options.path, entry.name);
    const relativePath = options.relativePath
      ? `${options.relativePath}${sep}${entry.name}`
      : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error("OpenCode configuration source symlink is unsafe");
    }
    if (entry.isDirectory()) {
      await scanDirectory({
        depth: options.depth + 1,
        files: options.files,
        incompleteReasons: options.incompleteReasons,
        path,
        relativePath,
        root: options.root,
      });
      continue;
    }
    if (entry.isFile()) {
      await recordFile({
        files: options.files,
        incompleteReasons: options.incompleteReasons,
        path,
        relativePath,
        root: options.root,
      });
      continue;
    }
    throw new Error("OpenCode configuration source has an unsafe file type");
  }
};

const scanOptionalPath = async (options: {
  readonly files: InventoryFile[];
  readonly incompleteReasons: Set<string>;
  readonly path: string;
  readonly recurse: boolean;
  readonly relativePath: string;
  readonly root: InventoryRoot;
}): Promise<void> => {
  try {
    if (options.recurse) {
      await scanDirectory({
        depth: 0,
        files: options.files,
        incompleteReasons: options.incompleteReasons,
        path: options.path,
        relativePath: options.relativePath,
        root: options.root,
      });
    } else {
      await recordFile(options);
    }
  } catch (cause) {
    if (!isMissing(cause)) {
      throw cause;
    }
  }
};

const collectRoot = async (
  root: InventoryRoot,
  files: InventoryFile[],
  incompleteReasons: Set<string>
): Promise<void> => {
  const resolvedRoot = resolve(root.path);
  let canonicalRoot: string;
  try {
    const metadata = await lstat(resolvedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("OpenCode configuration root is unsafe");
    }
    canonicalRoot = await realpath(resolvedRoot);
  } catch (cause) {
    if (isMissing(cause)) {
      return;
    }
    throw cause;
  }
  if (canonicalRoot !== resolvedRoot) {
    throw new Error("OpenCode configuration root changed identity");
  }
  const retainedRoot = { ...root, path: canonicalRoot } as const;
  const configNames = root.includeLegacyConfig
    ? ["config.json", "opencode.json", "opencode.jsonc"]
    : ["opencode.json", "opencode.jsonc"];
  for (const name of configNames) {
    await scanOptionalPath({
      files,
      incompleteReasons,
      path: resolve(canonicalRoot, name),
      recurse: false,
      relativePath: name,
      root: retainedRoot,
    });
  }
  if (!root.includeResources) {
    return;
  }
  for (const name of [
    "agent",
    "agents",
    "command",
    "commands",
    "mcp",
    "plugin",
    "plugins",
    "skill",
    "skills",
    "tool",
    "tools",
  ]) {
    await scanOptionalPath({
      files,
      incompleteReasons,
      path: resolve(canonicalRoot, name),
      recurse: true,
      relativePath: name,
      root: retainedRoot,
    });
  }
};

const collectAuthRoot = async (
  root: InventoryRoot,
  files: InventoryFile[],
  incompleteReasons: Set<string>
): Promise<void> => {
  const resolvedRoot = resolve(root.path);
  let canonicalRoot: string;
  try {
    const metadata = await lstat(resolvedRoot);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("OpenCode auth root is unsafe");
    }
    canonicalRoot = await realpath(resolvedRoot);
  } catch (cause) {
    if (isMissing(cause)) {
      return;
    }
    throw cause;
  }
  if (canonicalRoot !== resolvedRoot) {
    throw new Error("OpenCode auth root changed identity");
  }
  await scanOptionalPath({
    files,
    incompleteReasons,
    path: resolve(canonicalRoot, "auth.json"),
    recurse: false,
    relativePath: "auth.json",
    root: { ...root, path: canonicalRoot },
  });
};

const sourceRoots = (options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly projectRoot: string;
}): readonly InventoryRoot[] => {
  const roots: InventoryRoot[] = [
    {
      includeResources: false,
      includeLegacyConfig: false,
      path: options.projectRoot,
      scope: "project",
    },
    {
      includeResources: true,
      includeLegacyConfig: false,
      path: resolve(options.projectRoot, ".opencode"),
      scope: "project",
    },
  ];
  const xdgConfigHome = options.environment.XDG_CONFIG_HOME;
  const home = options.environment.HOME;
  if (xdgConfigHome !== undefined) {
    roots.push({
      includeResources: true,
      includeLegacyConfig: true,
      path: resolve(xdgConfigHome, "opencode"),
      scope: "xdg-config",
    });
  } else if (home !== undefined) {
    roots.push({
      includeResources: true,
      includeLegacyConfig: true,
      path: resolve(home, ".config", "opencode"),
      scope: "xdg-config",
    });
  }
  const dataHome = options.environment.XDG_DATA_HOME;
  if (dataHome !== undefined) {
    roots.push({
      includeResources: false,
      includeLegacyConfig: false,
      path: resolve(dataHome, "opencode"),
      scope: "global-auth",
    });
  } else if (home !== undefined) {
    roots.push({
      includeResources: false,
      includeLegacyConfig: false,
      path: resolve(home, ".local", "share", "opencode"),
      scope: "global-auth",
    });
  }
  const customConfigDirectory = options.environment.OPENCODE_CONFIG_DIR;
  if (customConfigDirectory !== undefined) {
    const path = resolve(options.projectRoot, customConfigDirectory);
    assertContained(resolve(options.projectRoot), path);
    roots.push({
      includeLegacyConfig: false,
      includeResources: true,
      path,
      scope: "project",
    });
  }
  const observed = new Set<string>();
  return roots.filter((root) => {
    const key = resolve(root.path);
    if (observed.has(key)) {
      return false;
    }
    observed.add(key);
    return true;
  });
};

export const inventoryAcpConfigSources = Effect.fn("inventoryAcpConfigSources")(
  function* (options: {
    readonly environment: NodeJS.ProcessEnv;
    readonly projectRoot: string;
    readonly repository: AcpAuthorityRepository;
  }): Effect.fn.Return<AcpConfigSourceInventory, HandlerFailure> {
    const files = yield* Effect.tryPromise({
      try: async () => {
        const collected: InventoryFile[] = [];
        const incompleteReasons = new Set<string>([
          "effective-runtime-manifest-unavailable",
        ]);
        for (const root of sourceRoots(options)) {
          if (root.scope === "global-auth") {
            await collectAuthRoot(root, collected, incompleteReasons);
            continue;
          }
          await collectRoot(root, collected, incompleteReasons);
        }
        const customConfig = options.environment.OPENCODE_CONFIG;
        if (customConfig !== undefined) {
          const projectRoot = resolve(options.projectRoot);
          const path = resolve(projectRoot, customConfig);
          assertContained(projectRoot, path);
          await scanOptionalPath({
            files: collected,
            incompleteReasons,
            path,
            recurse: false,
            relativePath: `config/${relative(projectRoot, path)}`,
            root: {
              includeLegacyConfig: false,
              includeResources: false,
              path: projectRoot,
              scope: "project",
            },
          });
        }
        collected.sort((left, right) =>
          `${left.scope}:${left.relativePath}`.localeCompare(
            `${right.scope}:${right.relativePath}`
          )
        );
        const uniqueFiles = collected.filter(
          (file, index) =>
            index === 0 ||
            `${file.scope}:${file.relativePath}` !==
              `${collected[index - 1]?.scope}:${collected[index - 1]?.relativePath}`
        );
        return {
          files: uniqueFiles,
          incompleteReasons: [...incompleteReasons].sort(),
        };
      },
      catch: inventoryFailure,
    });
    const categories = AcpConfigSourceCategory.map((category) => {
      const matching = files.files.filter((file) => file.category === category);
      return {
        category,
        fileCount: matching.length,
        totalBytes: matching.reduce((total, file) => total + file.size, 0),
      };
    }).filter((category) => category.fileCount > 0);
    const totalBytes = files.files.reduce(
      (total, file) => total + file.size,
      0
    );
    return {
      categories,
      complete: files.incompleteReasons.length === 0,
      digest: options.repository.digest(
        "opencode-config-source-inventory",
        JSON.stringify(files.files)
      ),
      fileCount: files.files.length,
      incompleteReasons: files.incompleteReasons,
      totalBytes,
    };
  }
);
