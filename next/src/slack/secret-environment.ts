const SLACK_TOKEN_ENVIRONMENT_NAME =
  /^SLACK_(?:APP|BOT)_TOKEN(?:_[A-Z0-9_]+)?$/;

export const isSlackTokenEnvironmentName = (name: string): boolean =>
  SLACK_TOKEN_ENVIRONMENT_NAME.test(name);
