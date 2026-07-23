# Slack same-app multi-workspace topology

## Question

What topology does Slack require when one Slack app is installed in multiple
workspaces, and what should Laborer's local multi-workspace proof preserve for a
future hosted service?

## Verified platform behavior

- One distributed Slack app uses an app-level `xapp-` token for Socket Mode and
  receives a distinct `xoxb-` bot token for each ordinary workspace
  installation. An organization-wide installation is a separate topology in
  which one installation can cover multiple workspaces. See Slack's
  [token types](https://docs.slack.dev/authentication/tokens/) and
  [OAuth installation flow](https://docs.slack.dev/authentication/installing-with-oauth/).
- A Socket Mode connection is opened for the app, not selected for a workspace.
  Additional connections, up to Slack's documented limit of ten per app,
  load-balance arbitrary payloads and cannot be assigned to particular
  workspaces. See
  [Socket Mode connections](https://docs.slack.dev/apis/events-api/using-socket-mode/#connections)
  and Bolt's
  [multi-workspace authorization model](https://docs.slack.dev/tools/bolt-js/concepts/authorization/).
- Socket Mode envelopes provide the `envelope_id` used for acknowledgement. The
  enclosed Events API callback identifies the target app and event context with
  fields including `api_app_id`, `team_id`, `event_id`, `authorizations`, and
  sometimes `event_context`. See the
  [Events API callback fields](https://docs.slack.dev/apis/events-api/#callback-field)
  and
  [`apps.event.authorizations.list`](https://docs.slack.dev/reference/methods/apps.event.authorizations.list).
- Slack can deliver one event that is visible through several installations.
  For Enterprise Grid and Slack Connect, the workspace where an event originated
  can differ from the installation through which the app can see it. Routing
  solely on `team_id` is therefore suitable only for an explicitly constrained
  ordinary-workspace proof. See Slack's
  [Enterprise Events API behavior](https://docs.slack.dev/enterprise/developing-for-enterprise-orgs/#events_api).
- Slack's Node `SocketModeClient` accepts the app token, calls
  `apps.connections.open`, emits the original payload, and acknowledges with the
  envelope ID. It does not select a bot token; choosing the installation-specific
  Web API client remains application logic. See the official
  [`SocketModeClient` source](https://github.com/slackapi/node-slack-sdk/blob/376dde15fb9d837fa2753686b5dd0c5864c8401f/packages/socket-mode/src/SocketModeClient.ts).
- Bolt's documented multi-workspace shape uses one receiver with an `authorize`
  function or installation store keyed by team and enterprise identity. That
  lookup returns the bot token and bot identity appropriate to an incoming
  payload. See Bolt's
  [authorization documentation](https://docs.slack.dev/tools/bolt-js/concepts/authorization/)
  and
  [installation-store documentation](https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth/#installation-store).
- Installing the same app outside its development workspace requires app
  distribution and OAuth. Marketplace distribution additionally rules out
  Socket Mode in favor of HTTP Events API ingress. See
  [app distribution](https://docs.slack.dev/app-management/distribution/) and
  [Slack's HTTP versus Socket Mode comparison](https://docs.slack.dev/apis/events-api/comparing-http-socket-mode/#which-one).

## Local-proof recommendation

The local proof should encode:

1. One app-level secret and one `SocketModeClient`.
2. Two ordinary workspace installations with separate opaque bot-token
   references.
3. Startup `auth.test` validation for every bot token, matching configured
   workspace identity and deriving each installation's bot identity.
4. Routing from validated event metadata to the matching installation and Web
   API client.
5. Successful mentions and thread replies in both workspaces over the shared
   socket.
6. Explicit tests for unknown workspaces, swapped token/workspace bindings,
   revoked tokens, and one slow or failed binding.
7. Workspace and installation identity in durable keys even when bindings share
   one Laborer root.
8. Explicit rejection or quarantine of organization-wide and ambiguous
   multi-authorization/Slack Connect events until their ownership policy is
   decided.
9. A transport-neutral installation-directory boundary so a hosted service can
   later own OAuth, token rotation, and HTTP Events API ingress without changing
   work-thread logic or `laborer.json`.

## Repository implications

- The current live entrypoint creates one app token, one bot-token `WebClient`,
  and one authenticated identity. The normalizer rejects events outside that
  identity's workspace. Multi-workspace support must separate the app-wide
  Socket Mode receiver from installation-specific Web API clients and bot
  identities.
- The daemon registry needs an installation key, expected workspace identity,
  bot-token secret reference, derived bot identity, and Laborer root for each
  binding. The app-level token belongs to the daemon-wide Slack receiver rather
  than an individual binding.
- The Socket Mode receiver is an app-wide shared failure domain. Per-installation
  Web API credentials, queues, handlers, roots, and health should remain isolated
  beneath it.
- The current proof should reject organization-wide installs and ambiguous
  Slack Connect authorization rather than silently choosing the wrong local
  binding.

## Documentation inconsistency to verify live

One SDK README instruction has described creating a client "for each workspace,"
while the platform's app-level routing, arbitrary multi-connection load
balancing, Bolt authorization model, and client implementation expose no
workspace selector for a Socket Mode connection. The live canary should record
events from two ordinary workspace installations over one connection and retain
that evidence.
