const SLACK_TOKEN_ENVIRONMENT_NAME =
  /^(?:SLACK_(?:APP|BOT)_TOKEN(?:_[A-Z0-9_]+)?|LABORER_ACP_CANARY_SLACK_(?:APP|BOT)_TOKEN)$/;

export const isSlackTokenEnvironmentName = (name: string): boolean =>
  SLACK_TOKEN_ENVIRONMENT_NAME.test(name);
