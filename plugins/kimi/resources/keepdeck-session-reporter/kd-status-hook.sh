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
# plugin owns the schema and this script owns only the mechanism. And it
# never copies a CLI VALUE out — only whether a declared key held a
# non-empty list — so no captured text is ever spliced back into JSON.
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
reduced=""
if [ "$bytes" -gt 261120 ]; then
  # Onto one line first. JSON's structural newlines are insignificant, but
  # grep and sed are line-oriented, so a pretty-printed payload would hide
  # every key below from both. CR goes too — it is JSON whitespace, and left
  # in place it would satisfy a "something follows the bracket" test.
  flat=$(printf '%s' "$payload" | tr '\n\r' '  ' 2>/dev/null)
  # The FIRST match, never sed's greedy last: tool payloads carry arbitrary
  # JSON and may quote this very key, while the real one leads in every
  # schema we arm. Bare-quote anchors are what keep a QUOTED occurrence from
  # matching at all — inside a JSON string the quotes arrive escaped (\").
  name=$(printf '%s' "$flat" \
    | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[A-Za-z]*"' 2>/dev/null \
    | head -n 1 \
    | sed -n 's/.*"\([A-Za-z]*\)"$/\1/p')
  [ -n "$name" ] || exit 0
  # NO CLI value is ever copied out. Splicing a captured string back into
  # JSON cannot be done safely without an escape-aware parser: a value
  # holding `\"` truncates at the backslash and the envelope becomes
  # unparseable, which the bridge drops WHOLE — losing the very edge this
  # reduction exists to save. So the reduction carries one fact per declared
  # key, "this key held a non-empty list", and nothing else. Everything the
  # key's VALUE would have said (an error class, a notification type) is
  # accepted as lost: degraded is recoverable, malformed is not.
  #
  # It rides BESIDE `event`, never inside it. `event` is the CLI's own words,
  # so a reduction may only take fields away, never invent one; `reduced` is
  # host-minted, and its contents are the argv the plugin gave us.
  for key in "$@"; do
    if printf '%s' "$flat" \
      | grep -q "\"$key\"[[:space:]]*:[[:space:]]*\[[[:space:]]*[^][:space:]]" 2>/dev/null; then
      reduced="$reduced,\"$key\""
    fi
  done
  reduced=$(printf ',"reduced":[%s]' "${reduced#,}")
  payload=$(printf '{"hook_event_name":"%s"}' "$name")
fi

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
# The trap reaps the staging file if this process is killed mid-write (kimi
# enforces a hook timeout with a signal) — after a successful mv there is
# nothing at $f and the rm is a no-op. The inbox never sweeps strays itself.
f=$(mktemp "$dir/agent.status-XXXXXXXX" 2>/dev/null) || exit 0
trap 'rm -f "$f"' EXIT INT TERM
printf '{"v":1,"type":"agent.status","paneId":"%s","token":"%s","payload":{"agent":"%s","event":%s%s}}' \
  "$pane" "$token" "$agent" "$payload" "$reduced" > "$f" && mv "$f" "$f.json"
exit 0
