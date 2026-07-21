#!/usr/bin/env bash

set -euo pipefail

session_store="${FAKE_OPENCODE_SESSION_STORE:-${FAKE_OPENCODE_LOG:-/tmp/fake-opencode}.sessions.json}"

if [[ "${1:-}" == "export" ]]; then
  shift
  export_session_id=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --pure)
        shift
        ;;
      *)
        export_session_id="$1"
        shift
        ;;
    esac
  done
  [[ -n "$export_session_id" && -f "$session_store" ]] || exit 3
  if [[ "${FAKE_OPENCODE_MODE:-normal}" == "export-invalid-utf8" ]]; then
    printf '\303\050'
    exit 0
  fi
  if [[ "${FAKE_OPENCODE_MODE:-normal}" == "export-pipe-sensitive" ]] &&
    ! node -e 'process.exit(require("node:fs").fstatSync(1).isFile() ? 0 : 1)'; then
    head -c 65536 "$session_store"
    exit 0
  fi
  jq -ce --arg mode "${FAKE_OPENCODE_MODE:-normal}" --arg sessionId "$export_session_id" '
    select(.info.id == $sessionId) |
    if $mode == "export-in-progress" then
      .messages[-1].info.time |= del(.completed)
    elif $mode == "export-aborted" then
      .messages[-1].info.error = {name: "MessageAbortedError", data: {message: "aborted"}}
    else . end
  ' "$session_store"
  exit 0
fi

[[ "${1:-}" == "run" ]] || exit 2
shift

session_id=""
model=""
agent=""
prompt=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --pure)
      shift
      ;;
    --format)
      shift 2
      ;;
    --dir)
      shift 2
      ;;
    --model)
      model="${2:-}"
      shift 2
      ;;
    --agent)
      agent="${2:-}"
      shift 2
      ;;
    --session)
      session_id="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

prompt="$(cat)"

kind="worker"
event_session_id="ses_worker_207"
response_text="Initial worker answer from the selected feature worker."
if [[ "$prompt" == *"LABORER_CLASSIFIER_PROTOCOL_V1"* ]]; then
  kind="classifier"
  event_session_id="ses_classifier_207"
  response_text="$(jq -cn \
    --arg classification "${FAKE_OPENCODE_CLASSIFICATION:-feature}" \
    '{classification: $classification}')"
elif [[ -n "$session_id" ]]; then
  kind="follow-up"
  event_session_id="$session_id"
  response_text="Follow-up answer from the resumed worker session."
fi

inline_config="${OPENCODE_CONFIG_CONTENT:-}"
if [[ -z "$inline_config" ]]; then
  inline_config='{}'
fi
tool_denied="$(printf '%s\n' "$inline_config" | jq -r --arg agent "$agent" '
  .permission["*"] == "deny" and
  .agent[$agent].permission["*"] == "deny" and
  .agent[$agent].tools["*"] == false
')"
slack_tokens_present=false
if [[ -n "${SLACK_APP_TOKEN+x}" || -n "${SLACK_BOT_TOKEN+x}" ]]; then
  slack_tokens_present=true
fi
selected_skill="none"
if [[ "$prompt" == *'`bug-to-pr`'* ]]; then
  selected_skill="bug-to-pr"
elif [[ "$prompt" == *'`feature-to-pr`'* ]]; then
  selected_skill="feature-to-pr"
fi

fake_mode="${FAKE_OPENCODE_MODE:-normal}"
oversized_response=false
if [[ "$fake_mode" == "wait" ]]; then
  : >"${FAKE_OPENCODE_STARTED:?}"
  while true; do
    sleep 1
  done
fi
if [[ "$fake_mode" == "stdout-overflow" ]]; then
  head -c $((1536 * 1024)) /dev/zero
  exit 0
fi
if [[ "$fake_mode" == "event-overflow" ]]; then
  for _event_number in $(seq 1 257); do
    printf '%s\n' '{"type":"ignored"}'
  done
  while true; do
    sleep 1
  done
fi
if [[ "$fake_mode" == "stderr-overflow" ]]; then
  head -c $((65 * 1024)) /dev/zero >&2
  while true; do
    sleep 1
  done
fi
if [[ "$fake_mode" == "jsonl-invalid-utf8" ]]; then
  printf '\303\050\n'
  exit 0
fi
if [[ "$fake_mode" == "oversized-reply" && "$kind" == "worker" ]]; then
  oversized_response=true
fi

jq -cn \
  --arg agent "$agent" \
  --arg kind "$kind" \
  --arg model "$model" \
  --arg selectedSkill "$selected_skill" \
  --argjson promptBytes "$(LC_ALL=C printf '%s' "$prompt" | wc -c | tr -d '[:space:]')" \
  --arg session "$session_id" \
  --argjson slackTokensPresent "$slack_tokens_present" \
  --argjson toolDenied "$tool_denied" \
  '{agent: $agent, kind: $kind, model: $model, promptBytes: $promptBytes, promptInArgv: false, selectedSkill: $selectedSkill, session: $session, slackTokensPresent: $slackTokensPresent, toolDenied: $toolDenied}' \
  >>"${FAKE_OPENCODE_LOG:?}"

message_sequence=0
if [[ -f "$session_store" ]]; then
  message_sequence="$(jq -er '.messages | length' "$session_store")"
fi
jq -cn \
  --arg assistantId "msg_assistant_${message_sequence}" \
  --arg sessionId "$event_session_id" \
  --arg text "$response_text" \
  --arg userId "msg_user_${message_sequence}" \
  --arg userText "prompt received through stdin" \
  --slurpfile previous <(if [[ -f "$session_store" && "$session_id" == "$event_session_id" ]]; then jq -c . "$session_store"; else printf '%s\n' 'null'; fi) '
    ($previous[0] // {info: {id: $sessionId}, messages: []}) |
    .info.id = $sessionId |
    .messages += [
      {info: {id: $userId, role: "user"}, parts: [{type: "text", text: $userText}]},
      {
        info: {
          id: $assistantId,
          sessionID: $sessionId,
          role: "assistant",
          time: {created: 1, completed: 2},
          parentID: $userId,
          modelID: "test-model",
          providerID: "test-provider",
          mode: "primary",
          agent: "test-agent",
          path: {cwd: "/tmp", root: "/tmp"},
          cost: 0,
          tokens: {input: 1, output: 1, reasoning: 0, cache: {read: 0, write: 0}},
          finish: "stop"
        },
        parts: [{type: "text", text: $text}]
      }
    ]
  ' >"$session_store.tmp"
mv -f -- "$session_store.tmp" "$session_store"

printf '%s\n' "FAKE OPENCODE SECRET DIAGNOSTIC" >&2
if [[ "$oversized_response" == "true" ]]; then
  printf '%s' '{"type":"text","sessionID":"ses_worker_207","part":{"type":"text","text":"'
  head -c $((1024 * 1024)) /dev/zero | tr '\0' x
  printf '%s\n' '","time":{"end":1}}}'
  exit 0
fi
jq -cn \
  --arg sessionID "$event_session_id" \
  --arg text "$response_text" \
  '{type: "text", sessionID: $sessionID, part: {type: "text", text: $text, time: {end: 1}}}'
