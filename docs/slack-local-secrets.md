# Local Slack secret storage

Laborer's local multi-workspace daemon keeps Slack credentials in macOS
Keychain rather than `next/.env.local`. The tracked worktree initializer copies
that environment file into agent worktrees, so Slack credentials must never be
stored there.

## Canonical development app

The distributable development app is owned by the ordinary Steeple workspace,
not the Slack Developer Sandbox.

| Item | Value |
| --- | --- |
| App ID | `A0BKAG3HS13` |
| Client ID | `1213883857746.11656547604037` |
| Steeple team ID | `T0169RZR7MY` |
| Freckle team ID | `T04UDJP9283` |

These identifiers are not secrets. Tokens and client secrets are stored under
the Keychain service names below.

| Keychain service | Credential |
| --- | --- |
| `laborer-slack-app-token-steeple` | App-level `xapp-[REDACTED]` token with `connections:write` |
| `laborer-slack-bot-token-steeple` | Steeple installation `xoxb-[REDACTED]` token |
| `laborer-slack-bot-token-freckle` | Freckle installation `xoxb-[REDACTED]` token |
| `laborer-slack-client-secret-steeple` | OAuth client secret for installing the app elsewhere |

## Store or rotate a credential

Run the following command, replacing the service name. Keeping `-w` as the last
argument makes Keychain prompt for the value without placing it in shell
history.

```sh
security add-generic-password -U \
  -a "$USER" \
  -s "laborer-slack-bot-token-freckle" \
  -w
```

Check that a credential exists without printing it:

```sh
security find-generic-password \
  -a "$USER" \
  -s "laborer-slack-bot-token-freckle" \
  -w >/dev/null
```

## Start the two-workspace daemon

Resolve secrets into the daemon process environment at launch. The configured
handler boundary filters Slack credential variables before invoking user code.

```sh
SLACK_APP_TOKEN="$(security find-generic-password -a "$USER" -s "laborer-slack-app-token-steeple" -w)" \
SLACK_BOT_TOKEN_STEEPLE="$(security find-generic-password -a "$USER" -s "laborer-slack-bot-token-steeple" -w)" \
SLACK_BOT_TOKEN_FRECKLE="$(security find-generic-password -a "$USER" -s "laborer-slack-bot-token-freckle" -w)" \
LABORER_SLACK_WORKSPACES='[{"teamId":"T0169RZR7MY","botTokenEnvironment":"SLACK_BOT_TOKEN_STEEPLE","root":"/Users/izakfilmalter/Projects/izakfilmalter/laborer"},{"teamId":"T04UDJP9283","botTokenEnvironment":"SLACK_BOT_TOKEN_FRECKLE","root":"/Users/izakfilmalter/Projects/Freckle/next"}]' \
bun run --cwd next start:slack
```

The workspace registry and identifiers are configuration, not credentials. The
token values exist only in the daemon environment and Keychain.

## Temporary OAuth Funnel

Use the tracked Funnel commands only while installing the app into another
workspace:

```sh
bun run --cwd next slack:funnel:on
bun run --cwd next slack:funnel:status
bun run --cwd next slack:funnel:off
```

The callback URL is currently:

```text
https://izaks-macbook-pro-1.tail08c37.ts.net/slack/oauth/callback
```

Disable Funnel after OAuth completes.
