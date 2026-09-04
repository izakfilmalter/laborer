# Reinstall the Slack app into a workspace

The daemon runs no OAuth server. Installing the app, or reauthorizing it after
`slack-app-manifest.yaml` gains a scope, is a one-shot operator tool:

```sh
bun run --cwd apps/bot slack:install freckle   # or: steeple
```

`scripts/slack-install.mjs` does everything in one run:

1. Reads the bot scopes from `slack-app-manifest.yaml`.
2. Starts a loopback callback server on `127.0.0.1:8787` and exposes it with
   `tailscale funnel --bg 8787` at `https://<magicdns-host>/slack/oauth/callback`.
   That URL must be registered as a redirect URL on the app
   (`https://api.slack.com/apps/A0BKAG3HS13`, OAuth & Permissions). It refuses
   to run if a Funnel is already configured.
3. Opens Slack's authorize page with the explicit scope list and a random
   `state`. Pick the target workspace and allow.
4. Exchanges the code with `oauth.v2.access`, rejects the token if the team ID
   is not the requested workspace or any manifest scope is missing, and stores
   it in Keychain (`laborer-slack-bot-token-<workspace>`).
5. Resets the Funnel and exits. It also resets on failure or after a
   ten-minute timeout.

Identifiers and Keychain service names, including the client secret it reads,
are in [`docs/slack-local-secrets.md`](../../docs/slack-local-secrets.md). Set
`TAILSCALE_BIN` if the App Store Tailscale binary is not at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`.

Apply manifest changes on the app's settings page first; Slack grants a new
scope only when the workspace reauthorizes with it in the request, which is why
the tool always sends the full manifest list rather than using Slack's
"reinstall" link.

Afterwards restart the daemon (`bun run start:bot`) and confirm
`slack-daemon.log` no longer reports `missing_scope`.

## Manual fallback

If Tailscale is unavailable, the same exchange works by hand. Open the
authorize URL yourself, copy `code=` from the address bar of the failed
redirect (codes are single use and expire in about ten minutes), then:

```sh
CODE='<code>'
SERVICE='laborer-slack-bot-token-freckle'
RESPONSE="$(curl -sS -X POST https://slack.com/api/oauth.v2.access \
  -d client_id=1213883857746.11656547604037 \
  -d "client_secret=$(security find-generic-password -a "$USER" -s laborer-slack-client-secret-steeple -w)" \
  -d "code=${CODE}" \
  -d redirect_uri=https://izaks-macbook-pro-1.tail08c37.ts.net/slack/oauth/callback)"
echo "$RESPONSE" | jq '{ok, error, scope, team}'
echo "$RESPONSE" | jq -er .access_token \
  | xargs -I{} security add-generic-password -U -a "$USER" -s "$SERVICE" -w '{}'
```

Check `scope` and `team.id` before trusting the stored token.
