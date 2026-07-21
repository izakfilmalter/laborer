import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { SlackConfigValidationError } from "./errors.ts";

const APP_TOKEN_PREFIX = ["x", "app", "-"].join("");
const BOT_TOKEN_PREFIX = ["x", "oxb", "-"].join("");

export interface SlackConfigShape {
  readonly appToken: Redacted.Redacted<string>;
  readonly botToken: Redacted.Redacted<string>;
}

export class SlackConfig extends Context.Service<
  SlackConfig,
  SlackConfigShape
>()("@laborer/slack/SlackConfig") {}

const validateToken = (
  variable: string,
  token: Redacted.Redacted<string>,
  prefix: string
): Effect.Effect<Redacted.Redacted<string>, SlackConfigValidationError> => {
  const value = Redacted.value(token);
  if (value.trim().length === 0) {
    return SlackConfigValidationError.make({ variable, reason: "blank" });
  }
  return value.startsWith(prefix)
    ? Effect.succeed(token)
    : SlackConfigValidationError.make({
        variable,
        reason: "unexpected-token-kind",
      });
};

export const loadSlackConfig: Effect.Effect<
  SlackConfigShape,
  Config.ConfigError | SlackConfigValidationError
> = Effect.gen(function* () {
  const appToken = yield* Config.redacted("SLACK_APP_TOKEN");
  const botToken = yield* Config.redacted("SLACK_BOT_TOKEN");
  return SlackConfig.of({
    appToken: yield* validateToken(
      "SLACK_APP_TOKEN",
      appToken,
      APP_TOKEN_PREFIX
    ),
    botToken: yield* validateToken(
      "SLACK_BOT_TOKEN",
      botToken,
      BOT_TOKEN_PREFIX
    ),
  });
});

export const slackConfigLayer: Layer.Layer<
  SlackConfig,
  Config.ConfigError | SlackConfigValidationError
> = Layer.effect(SlackConfig, loadSlackConfig);

export class SlackRuntimeIdentity extends Schema.Class<SlackRuntimeIdentity>(
  "SlackRuntimeIdentity"
)({
  botId: Schema.String,
  botUserId: Schema.String,
  teamId: Schema.String,
}) {}
