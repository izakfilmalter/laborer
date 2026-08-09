const SLACK_CREDENTIAL_ENVIRONMENT_NAME =
  /^(?:SLACK_[A-Z0-9_]*(?:TOKEN|SECRET)(?:_[A-Z0-9_]+)?|SLACK_(?:API_KEY|(?:INCOMING_)?WEBHOOK_URL)(?:_[A-Z0-9_]+)?|LABORER_ACP_CANARY_SLACK_(?:APP|BOT)_TOKEN)$/i;

const LABORER_PRIVATE_ENVIRONMENT_NAME =
  /^(?:LABORER_(?:ACP|ACTION_BRIDGE|BRIDGE|CANARY|MEMORY)(?:_|$)|LABORER_OPENCODE_MODEL$|LABORER_SLACK_WORKSPACES$)/i;

const OPENCODE_CONVERSATION_OVERRIDE_ENVIRONMENT_NAME =
  /^(?:OPENCODE_CONFIG(?:_CONTENT|_DIR)?|OPENCODE_DISABLE_PROJECT_CONFIG|OPENCODE_PERMISSION)$/i;

export const isSlackCredentialEnvironmentName = (name: string): boolean =>
  SLACK_CREDENTIAL_ENVIRONMENT_NAME.test(name);

export const isSlackTokenEnvironmentName = isSlackCredentialEnvironmentName;

/** Credentials owned by an adapter or by Laborer's local control plane. */
export const isSensitiveCredentialEnvironmentName = (name: string): boolean =>
  isSlackCredentialEnvironmentName(name) ||
  LABORER_PRIVATE_ENVIRONMENT_NAME.test(name) ||
  OPENCODE_CONVERSATION_OVERRIDE_ENVIRONMENT_NAME.test(name);
