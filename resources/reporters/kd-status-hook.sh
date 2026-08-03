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
# payload whole and reduces it to its event name. It extracts nothing else:
# carrying a field out means re-quoting a captured value, which needs an
# escape-aware parser this has no way to be.
#
# MUST stay silent and exit 0: codex's TUI renders a history cell for a
# hook that fails or prints, and a status reporter has no business in the
# transcript.

# BYTE semantics for every tool below. Under a UTF-8 locale `tr` ABORTS at
# the first invalid byte and truncates its output, so one bad byte in a
# large assistant message would silently cost us everything after it — a
# wrong answer dressed as a clean run. A payload is bytes here, not text.
LC_ALL=C
export LC_ALL

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

# The bridge drops an oversized envelope whole — and a dropped Stop would
# strand the pane on "working" — so past the cap we reduce instead of losing
# it. The cap mirrors the bridge's OWN envelope limit less the wrapper, so
# nothing is reduced that would have been delivered intact.
#
# BYTES, not ${#payload}: the cap is a byte cap, and a character count
# would wave a large CJK/Cyrillic message through at 2-3x its real size.
bytes=$(printf '%s' "$payload" | wc -c)
if [ "$bytes" -gt 261120 ]; then
  # Onto one line first. JSON's structural newlines are insignificant, but
  # grep and sed are line-oriented, so a pretty-printed payload would hide
  # the event name from both.
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
  # The name is ALL that survives, and nothing else is attempted. Carrying a
  # field out would mean re-quoting a captured value, and `"[^"]*"` stops at
  # the backslash of an escaped quote — the envelope then closes mid-string
  # and the bridge drops it whole, losing the edge entirely. The name is
  # safe only because its charset is constrained to [A-Za-z] above.
  #
  # So an oversized turn-ending payload reads as an ENDING even when
  # background work is still live: the pane says finished a little early and
  # the next prompt corrects it. That is the recoverable direction, and the
  # same one this file chooses everywhere else.
  payload=$(printf '{"hook_event_name":"%s"}' "$name")
fi

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
# The trap reaps the staging file if this process is killed mid-write (kimi
# enforces a hook timeout with a signal) — after a successful mv there is
# nothing at $f and the rm is a no-op. The inbox never sweeps strays itself.
f=$(mktemp "$dir/agent.status-XXXXXXXX" 2>/dev/null) || exit 0
trap 'rm -f "$f"' EXIT INT TERM
printf '{"v":1,"type":"agent.status","paneId":"%s","token":"%s","payload":{"agent":"%s","event":%s}}' \
  "$pane" "$token" "$agent" "$payload" > "$f" && mv "$f" "$f.json"
exit 0
