#!/bin/sh
# KeepDeck status reporter — a hook shared by the turn-lifecycle events
# (UserPromptSubmit / Stop / StopFailure / Notification / PostToolUse and
# their codex/kimi equivalents). Armed PER SPAWN beside kd-session-hook.sh;
# the agent id is
# $1 because the payload does not name its CLI and the webview dispatches
# normalizers by agent.
#
# Speaks bridge protocol v1: the whole hook payload (JSON on stdin) rides
# VERBATIM under payload.event — no field extraction, so this script never
# chases a CLI's schema. Same tmp + rename discipline as the session hook.
#
# The ONE exception is the oversize path below, which cannot forward a
# payload whole. It still names no field itself: the remaining arguments
# ($2...) are the keys THAT CLI's plugin declared load-bearing, because the
# plugin owns the schema and this script owns only the mechanism.
#
# MUST stay silent and exit 0: codex's TUI renders a history cell for a
# hook that fails or prints, and a status reporter has no business in the
# transcript.

[ -n "$KEEPDECK_BRIDGE" ] || exit 0
agent="$1"
[ -n "$agent" ] || exit 0
# What is left in "$@" is the keep-key list for a reduction.
shift

# The values are KeepDeck-minted (uuid-ish, no escapes) and the dir is a path
# without quotes — extracting quoted JSON strings with sed is safe here.
field() {
  printf '%s' "$KEEPDECK_BRIDGE" \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}
dir=$(field dir)
pane=$(field pane)
token=$(field token)
[ -n "$dir" ] && [ -n "$pane" ] && [ -n "$token" ] || exit 0

payload=$(cat)
[ -n "$payload" ] || exit 0

# The bridge drops an oversized envelope whole — and a dropped Stop would
# strand the pane on "working" — so past the cap we reduce instead of losing
# it. The cap mirrors the bridge's OWN envelope limit less the wrapper, so
# nothing is reduced that would have been delivered intact.
#
# BYTES, not ${#payload}: that counts characters under the UTF-8 locale
# every spawn gets, and a large CJK/Cyrillic message slips a character
# guard at 2-3x its size in bytes.
bytes=$(printf '%s' "$payload" | wc -c)
if [ "$bytes" -gt 261120 ]; then
  # Onto one line first. JSON's structural newlines are insignificant, but
  # grep and sed are line-oriented, so a pretty-printed payload would hide
  # every key below from both. CR goes too — it is JSON whitespace, and left
  # in place it would satisfy a "something follows the bracket" test.
  flat=$(printf '%s' "$payload" | tr '\n\r' '  ')
  # The FIRST match, never sed's greedy last: tool payloads carry arbitrary
  # JSON and may quote this very key, while the real one leads in every
  # schema we arm. Bare-quote anchors are what keep a QUOTED occurrence from
  # matching at all — inside a JSON string the quotes arrive escaped (\").
  name=$(printf '%s' "$flat" \
    | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[A-Za-z]*"' \
    | head -n 1 \
    | sed -n 's/.*"\([A-Za-z]*\)"$/\1/p')
  [ -n "$name" ] || exit 0
  # Each declared key survives as the fact the normalizer reads: a scalar
  # keeps its value, a non-empty list collapses to a marker (no consumer
  # reads the entries, only whether any exist). A key that is absent, empty
  # or neither shape simply does not appear — same as today.
  kept=""
  for key in "$@"; do
    value=$(printf '%s' "$flat" \
      | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | head -n 1 \
      | sed -n 's/.*:[[:space:]]*"\([^"]*\)"$/\1/p')
    if [ -n "$value" ]; then
      kept="$kept,\"$key\":\"$value\""
    elif printf '%s' "$flat" \
      | grep -q "\"$key\"[[:space:]]*:[[:space:]]*\[[[:space:]]*[^][:space:]]"; then
      kept="$kept,\"$key\":[{\"type\":\"reduced\"}]"
    fi
  done
  payload=$(printf '{"hook_event_name":"%s"%s}' "$name" "$kept")
fi

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
# The trap reaps the staging file if this process is killed mid-write (kimi
# enforces a hook timeout with a signal) — after a successful mv there is
# nothing at $f and the rm is a no-op. The inbox never sweeps strays itself.
f=$(mktemp "$dir/agent.status-XXXXXXXX") || exit 0
trap 'rm -f "$f"' EXIT INT TERM
printf '{"v":1,"type":"agent.status","paneId":"%s","token":"%s","payload":{"agent":"%s","event":%s}}' \
  "$pane" "$token" "$agent" "$payload" > "$f" && mv "$f" "$f.json"
exit 0
