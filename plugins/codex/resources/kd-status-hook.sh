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
# MUST stay silent and exit 0: codex's TUI renders a history cell for a
# hook that fails or prints, and a status reporter has no business in the
# transcript.

[ -n "$KEEPDECK_BRIDGE" ] || exit 0
agent="$1"
[ -n "$agent" ] || exit 0

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
# The bridge drops oversized envelopes whole — and a dropped Stop would
# strand the pane on "working". Above the guard, reduce instead of losing
# it (a bare edge beats a lost one); the name's charset is ours to trust.
# BYTES, not ${#payload}: that counts characters under the UTF-8 locale
# every spawn gets, and a large CJK/Cyrillic message slips a character
# guard at 2-3x its size in bytes — past the bridge's byte cap.
#
# The reduction MUST carry the in-flight background-work flag. A turn-ending
# payload that lists still-running work is not an ending, and a reduction
# that dropped the list would read as "nothing running" — reporting the very
# "finished" the flag exists to prevent, on the one payload big enough to
# need reducing (the oversize driver is the final assistant message, which
# rides on exactly that event). Only NON-EMPTINESS survives: no consumer
# reads the entries, so a marker list carries the whole fact.
#
# The bare-quote anchors are what keep a payload that merely QUOTES this key
# from tripping it — inside a JSON string the quotes arrive escaped (\"), so
# `"key":` cannot match there. Same reasoning the event-name extract relies on.
bytes=$(printf '%s' "$payload" | wc -c)
if [ "$bytes" -gt 131072 ]; then
  name=$(printf '%s' "$payload" \
    | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p' \
    | head -n 1)
  [ -n "$name" ] || exit 0
  if printf '%s' "$payload" \
    | grep -q '"background_tasks"[[:space:]]*:[[:space:]]*\[[[:space:]]*[^] 	]'; then
    payload=$(printf \
      '{"hook_event_name":"%s","background_tasks":[{"type":"reduced"}]}' "$name")
  else
    payload=$(printf '{"hook_event_name":"%s"}' "$name")
  fi
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
