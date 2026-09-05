#!/usr/bin/env bash
# Model-backed smoke for Pi package discovery and optional live Maestri transport.
# shellcheck disable=SC2016 # jq programs intentionally use literal `$`.
set -euo pipefail
umask 077

mode=${1:---fake}
case "$mode" in
  --fake|--live) ;;
  *) printf 'usage: %s [--fake|--live]\n' "$0" >&2; exit 2 ;;
esac

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
MODEL=azure-openai-responses/gpt-6-astra
fixture=$(mktemp -d "${TMPDIR:-/tmp}/maestri-pi-v01-smoke.XXXXXX")
chmod 700 "$fixture"
png_path=""
cleanup() { rm -rf "$fixture"; [[ -z $png_path ]] || rm -f "$png_path"; }
trap cleanup EXIT

run_pi() { # <tool> <prompt> <output> <seconds>
  local tool=$1 prompt=$2 output=$3 seconds=$4
  timeout --kill-after=5s "${seconds}s" \
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
  argv_file="$fixture/argv"
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
  export MAESTRI_SMOKE_ARGV_FILE="$argv_file"
  export MAESTRI_WORKSPACE_ID=fixture-sensitive-workspace
  export MAESTRI_SOCKET=/tmp/fixture-sensitive-socket
  export MAESTRI_TOKEN=fixture-sensitive-token

  png_path="${TMPDIR:-/tmp}/maestri-portal-$(cat /proc/sys/kernel/random/uuid).png"
  printf '%s\n' "$png_path" > "$fixture/png-path"
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQCbn9HwAERgJTEuXMlgAAAABJRU5ErkJggg==' | base64 -d > "$png_path"

  events="$fixture/fake.jsonl"
  run_pi maestri_list 'Call maestri_list exactly once, then answer only DONE.' "$events" 180
  printf 'list\n' | cmp -s - "$argv_file"
  assert_tool_result "$events" maestri_list
  assert_tool_args "$events" maestri_list \
    'any(.[]; .type == "tool_execution_start" and .toolName == $tool and .args == {})'
  assert_no_maestri_secret "$events" "$events.stderr"

  : > "$argv_file"
  note_events="$fixture/note.jsonl"
  run_pi maestri_note_create,maestri_note_read,maestri_note_edit,maestri_note_stack \
    'Create a new connected note named "Smoke note" in the fichário "Smoke book" with the content "Transport checked". Then answer only DONE.' \
    "$note_events" 180
  printf 'note\ncreate\n--name\nSmoke note\n--stack\nSmoke book\nTransport checked\n' | cmp -s - "$argv_file"
  assert_tool_result "$note_events" maestri_note_create
  assert_tool_args "$note_events" maestri_note_create \
    'any(.[]; .type == "tool_execution_start" and .toolName == $tool and .args == {name: "Smoke note", content: "Transport checked", stack: "Smoke book"})'
  assert_no_maestri_secret "$note_events" "$note_events.stderr"

  : > "$argv_file"
  portal_events="$fixture/portal.jsonl"
  run_pi maestri_portal,maestri_portal_device \
    'maestri_list already confirmed a connected web portal named "Smoke web". Take a screenshot of it. Do not close it or navigate anywhere.' \
    "$portal_events" 180
  printf 'portal\nscreenshot\nSmoke web\n' | cmp -s - "$argv_file"
  assert_tool_result "$portal_events" maestri_portal
  jq -e -s 'any(.[]; .type == "tool_execution_end" and .toolName == "maestri_portal" and .isError != true and any(.result.content[]; .type == "image" and .mimeType == "image/png"))' "$portal_events" >/dev/null
  assert_no_maestri_secret "$portal_events" "$portal_events.stderr"

  : > "$argv_file"
  device_events="$fixture/device.jsonl"
  run_pi maestri_portal,maestri_portal_device \
    'List the Android phones and emulators available in Maestri. Do not open a device or interact with it.' \
    "$device_events" 180
  printf 'portal\ndevices\n' | cmp -s - "$argv_file"
  assert_tool_result "$device_events" maestri_portal_device
  assert_no_maestri_secret "$device_events" "$device_events.stderr"

  printf 'PASS: Pi discovery, agent/note transport, web image result, Android tool selection, fixed argv and redaction\n'
  exit 0
fi

target=${MPO_LIVE_TARGET:-}
[[ -n $target ]] || { echo 'MPO_LIVE_TARGET is required for --live' >&2; exit 2; }
[[ -n ${MAESTRI_WORKSPACE_ID:-} && -n ${MAESTRI_SOCKET:-} ]] || {
  echo 'live smoke requires a connected Linux Maestri terminal' >&2
  exit 2
}

list_events="$fixture/list.jsonl"
node "$ROOT/tests/invoke-v01.ts" list > "$list_events" 2> "$list_events.stderr"
jq -e --arg target "$target" '
  (.content[0].text | startswith("UNTRUSTED PEER OUTPUT")) and
  (.content[0].text | contains($target)) and .details.action == "list"
' "$list_events" >/dev/null

check_events="$fixture/check.jsonl"
node "$ROOT/tests/invoke-v01.ts" check "$target" > "$check_events" 2> "$check_events.stderr"
jq -e '(.content[0].text | startswith("UNTRUSTED PEER OUTPUT")) and .details.action == "check"' \
  "$check_events" >/dev/null
node --input-type=module - "$ROOT" "$check_events" <<'JS'
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { classifyPiReadiness } = await import(pathToFileURL(process.argv[2] + "/src/readiness.ts").href);
const result = JSON.parse(readFileSync(process.argv[3], "utf8"));
const now = Date.now();
const readiness = classifyPiReadiness({
  terminal_type: "pi",
  screen: result.content[0].text,
  truncated: result.details.truncated !== false,
  encoding_valid: true,
  captured_at_ms: now,
  now_ms: now,
  max_age_ms: 0,
});
if (readiness.verdict !== "ready") throw new Error("target Pi is " + readiness.verdict + "; ask was not sent");
JS

nonce=$(cat /proc/sys/kernel/random/uuid)
remote_prompt="Read-only transport check. Do not run commands or modify files. Reply with exactly ACK:$nonce"
ask_events="$fixture/ask.jsonl"
node "$ROOT/tests/invoke-v01.ts" ask "$target" "$remote_prompt" \
  > "$ask_events" 2> "$ask_events.stderr"
jq -e --arg nonce "$nonce" '
  (.content[0].text | startswith("UNTRUSTED PEER OUTPUT")) and
  (.content[0].text | contains("ACK:" + $nonce)) and .details.action == "ask"
' "$ask_events" >/dev/null
assert_no_maestri_secret "$list_events" "$list_events.stderr" \
  "$check_events" "$check_events.stderr" "$ask_events" "$ask_events.stderr"
printf 'PASS: live maestri_list/check/ask target=%s readiness=verified nonce=round-trip\n' "$target"
