#!/usr/bin/env bash
# Model-backed smoke for Pi package discovery and optional live Maestri transport.
# shellcheck disable=SC2016 # jq programs intentionally use literal `$`.
set -Eeuo pipefail
umask 077

mode=${1:---fake}
case "$mode" in
  --fake|--live) ;;
  *) printf 'usage: %s [--fake|--live]\n' "$0" >&2; exit 2 ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
MODEL=azure-openai-responses/gpt-6-astra
PI_TIMEOUT_SECONDS=180
MAX_MODEL_CALLS=4
[[ $mode == --fake ]] || MAX_MODEL_CALLS=0
artifact_root=${MPO_SMOKE_ARTIFACTS_DIR:-$ROOT/.artifacts/smoke-v01}
run_id=$(printf '%s-%s-%s' "$(date -u +%Y%m%dT%H%M%S.%NZ)" "$$" "${mode#--}")
mkdir -p "$artifact_root"
artifacts="$artifact_root/$run_id"
mkdir "$artifacts"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/maestri-pi-v01-smoke.XXXXXX")
chmod 700 "$fixture"
png_path=""
png_owned=0
model_calls=0
printf 'mode=%s\nmodel=%s\nmodel_call_limit=%s\nper_call_timeout_seconds=%s\nstarted_at=%s\n' \
  "$mode" "$MODEL" "$MAX_MODEL_CALLS" "$PI_TIMEOUT_SECONDS" "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
  > "$artifacts/run-metadata.txt"
printf 'smoke artifacts: %s\n' "$artifacts" >&2

cleanup() {
  rm -rf "$fixture"
  (( png_owned == 0 )) || rm -f "$png_path"
}

record_failure() {
  local status=$? line=${BASH_LINENO[0]} command=$BASH_COMMAND
  if [[ ! -e $artifacts/first-failure.txt ]]; then
    printf 'status=%s\nline=%s\ncommand=%q\nfailed_at=%s\n' \
      "$status" "$line" "$command" "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" \
      > "$artifacts/first-failure.txt"
  fi
  return "$status"
}

trap record_failure ERR
trap cleanup EXIT

run_pi() { # <tool> <prompt> <output> <argv-file>
  local tool=$1 prompt=$2 output=$3 argv_path=$4
  ((model_calls += 1))
  if (( model_calls > MAX_MODEL_CALLS )); then
    printf 'model call limit exceeded: %s\n' "$MAX_MODEL_CALLS" >&2
    return 2
  fi
  MAESTRI_SMOKE_ARGV_FILE="$argv_path" timeout --kill-after=5s "${PI_TIMEOUT_SECONDS}s" \
    pi -e "$ROOT" --mode json -p --no-session \
      --no-skills --no-extensions --no-prompt-templates --no-context-files \
      --no-approve --model "$MODEL" --thinking low --tools "$tool" \
      "$prompt" > "$output" 2> "$output.stderr"
}

assert_tool_result() { # <jsonl> <tool>
  jq -e -s --arg tool "$2" '
    ([.[] | select(.type == "tool_execution_start" and .toolName == $tool)] | length) == 1 and
    ([.[] | select(
      .type == "tool_execution_end" and .toolName == $tool and
      ((.result.content[0].text // "") | startswith("UNTRUSTED PEER OUTPUT"))
    )] | length) == 1
  ' "$1" >/dev/null
}

assert_tool_args() { # <jsonl> <tool> <jq predicate>
  local file=$1 tool=$2 predicate=$3
  shift 3
  jq -e -s --arg tool "$tool" "$@" "$predicate" "$file" >/dev/null
}

assert_no_maestri_secret() { # <file>...
  local file value name
  for name in MAESTRI_TOKEN MAESTRI_SOCKET MAESTRI_WORKSPACE_ID MAESTRI_TERMINAL_ID; do
    value=${!name:-}
    [[ -z $value ]] || for file in "$@"; do
      if grep -F -- "$value" "$file" >/dev/null; then
        printf 'secret value leaked into %s\n' "$file" >&2
        return 1
      fi
    done
  done
}

if [[ $mode == --fake ]]; then
  fake_cli="$fixture/maestri"
  argv_file="$artifacts/list.argv"
  cat > "$fake_cli" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >> "${MAESTRI_SMOKE_ARGV_FILE:?}"
if [[ ${1:-} == portal ]]; then
  case ${2:-} in
    screenshot) cat "$(dirname "$0")/png-path" ;;
    devices) printf 'No Android devices available.\n' ;;
    *) printf 'unexpected portal command\n' >&2; exit 1 ;;
  esac
  exit 0
fi
printf 'fake-peer token=%s socket=%s workspace=%s\n' \
  "${MAESTRI_TOKEN:-}" "${MAESTRI_SOCKET:-}" "${MAESTRI_WORKSPACE_ID:-}"
SH
  chmod 700 "$fake_cli"
  for name in $(compgen -e); do
    [[ $name == MAESTRI_* ]] && unset "$name"
  done
  export MAESTRI_CLI="$fake_cli"
  export MAESTRI_WORKSPACE_ID=fixture-sensitive-workspace
  export MAESTRI_SOCKET=/tmp/fixture-sensitive-socket
  export MAESTRI_TOKEN=fixture-sensitive-token

  png_path="${TMPDIR:-/tmp}/maestri-portal-$(cat /proc/sys/kernel/random/uuid).png"
  [[ ! -e $png_path ]]
  png_owned=1
  printf '%s\n' "$png_path" > "$fixture/png-path"
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQCbn9HwAERgJTEuXMlgAAAABJRU5ErkJggg==' | base64 -d > "$png_path"

  events="$artifacts/fake.jsonl"
  run_pi maestri_list 'Call maestri_list exactly once, then answer only DONE.' "$events" "$argv_file"
  printf 'list\n' | cmp -s - "$argv_file"
  assert_tool_result "$events" maestri_list
  assert_tool_args "$events" maestri_list \
    'any(.[]; .type == "tool_execution_start" and .toolName == $tool and .args == {})'
  assert_no_maestri_secret "$events" "$events.stderr"

  argv_file="$artifacts/note.argv"
  note_events="$artifacts/note.jsonl"
  run_pi maestri_note_create,maestri_note_read,maestri_note_edit,maestri_note_stack \
    'Create a new connected note named "Smoke note" in the fichário "Smoke book" with the content "Transport checked". Then answer only DONE.' \
    "$note_events" "$argv_file"
  printf 'note\ncreate\n--name\nSmoke note\n--stack\nSmoke book\nTransport checked\n' | cmp -s - "$argv_file"
  assert_tool_result "$note_events" maestri_note_create
  assert_tool_args "$note_events" maestri_note_create \
    'any(.[]; .type == "tool_execution_start" and .toolName == $tool and .args == {name: "Smoke note", content: "Transport checked", stack: "Smoke book"})'
  assert_no_maestri_secret "$note_events" "$note_events.stderr"

  argv_file="$artifacts/portal.argv"
  portal_events="$artifacts/portal.jsonl"
  run_pi maestri_portal,maestri_portal_device \
    'maestri_list already confirmed a connected web portal named "Smoke web". Take a screenshot of it. Do not close it or navigate anywhere.' \
    "$portal_events" "$argv_file"
  printf 'portal\nscreenshot\nSmoke web\n' | cmp -s - "$argv_file"
  assert_tool_result "$portal_events" maestri_portal
  jq -e -s 'any(.[]; .type == "tool_execution_end" and .toolName == "maestri_portal" and .isError != true and any(.result.content[]; .type == "image" and .mimeType == "image/png"))' "$portal_events" >/dev/null
  assert_no_maestri_secret "$portal_events" "$portal_events.stderr"

  argv_file="$artifacts/device.argv"
  device_events="$artifacts/device.jsonl"
  run_pi maestri_portal,maestri_portal_device \
    'List the Android phones and emulators available in Maestri. Do not open a device or interact with it.' \
    "$device_events" "$argv_file"
  printf 'portal\ndevices\n' | cmp -s - "$argv_file"
  assert_tool_result "$device_events" maestri_portal_device
  assert_no_maestri_secret "$device_events" "$device_events.stderr"

  printf 'status=pass\nfinished_at=%s\nmodel_calls=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$model_calls" > "$artifacts/result.txt"
  printf 'PASS: Pi discovery, agent/note transport, web image result, Android tool selection, fixed argv and redaction; artifacts=%s\n' "$artifacts"
  exit 0
fi

target=${MPO_LIVE_TARGET:-}
[[ -n $target ]] || { echo 'MPO_LIVE_TARGET is required for --live' >&2; exit 2; }
[[ -n ${MAESTRI_WORKSPACE_ID:-} && -n ${MAESTRI_SOCKET:-} ]] || {
  echo 'live smoke requires a connected Linux Maestri terminal' >&2
  exit 2
}

list_events="$artifacts/list.jsonl"
node "$ROOT/tests/invoke-v01.ts" list > "$list_events" 2> "$list_events.stderr"
jq -e --arg target "$target" '
  (.content[0].text | startswith("UNTRUSTED PEER OUTPUT")) and
  (.content[0].text | contains($target)) and .details.action == "list"
' "$list_events" >/dev/null

check_events="$artifacts/check.jsonl"
node "$ROOT/tests/invoke-v01.ts" check "$target" > "$check_events" 2> "$check_events.stderr"
jq -e '(.content[0].text | startswith("UNTRUSTED PEER OUTPUT")) and .details.action == "check"' \
  "$check_events" >/dev/null
node "$ROOT/tests/smoke-readiness.mjs" "$ROOT" "$check_events"

nonce=$(cat /proc/sys/kernel/random/uuid)
remote_prompt="Read-only transport check. Do not run commands or modify files. Reply with exactly ACK:$nonce"
ask_events="$artifacts/ask.jsonl"
node "$ROOT/tests/invoke-v01.ts" ask "$target" "$remote_prompt" \
  > "$ask_events" 2> "$ask_events.stderr"
jq -e --arg nonce "$nonce" '
  (.content[0].text | startswith("UNTRUSTED PEER OUTPUT")) and
  (.content[0].text | contains("ACK:" + $nonce)) and .details.action == "ask"
' "$ask_events" >/dev/null
assert_no_maestri_secret "$list_events" "$list_events.stderr" \
  "$check_events" "$check_events.stderr" "$ask_events" "$ask_events.stderr"
printf 'status=pass\nfinished_at=%s\nmodel_calls=0\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" > "$artifacts/result.txt"
printf 'PASS: live maestri_list/check/ask target=%s readiness=verified nonce=round-trip artifacts=%s\n' "$target" "$artifacts"
