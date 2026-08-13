export const MINIMUM_MCP_NODE_MAJOR = 24
const NODE_VERSION_PATTERN = /^v?(\d+)(?:\.|$)/

export const nodeMajorVersion = (version: string): number | undefined => {
  const match = NODE_VERSION_PATTERN.exec(version)
  if (match === null) {
    return undefined
  }
  const major = Number(match[1])
  return Number.isSafeInteger(major) ? major : undefined
}

export const unsupportedMcpNodeMessage = (
  version: string
): string | undefined => {
  const major = nodeMajorVersion(version)
  return major !== undefined && major >= MINIMUM_MCP_NODE_MAJOR
    ? undefined
    : `Laborer MCP requires Node.js ${String(MINIMUM_MCP_NODE_MAJOR)} or newer (running ${version}).`
}
