#!/bin/sh
# KeepDeck's Kimi Code SessionStart reporter. The plugin is user-global in
# Kimi, but this hook is armed only by the per-spawn KEEPDECK_BRIDGE value: an
# ordinary Kimi invocation exits here without reading or writing anything.

[ -n "$KEEPDECK_BRIDGE" ] || exit 0

# Bridge values are KeepDeck-minted uuid-ish strings and a filesystem path;
# they contain no JSON quote escapes, so this deliberately tiny POSIX parser
# is sufficient without adding jq as a runtime dependency.
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
sid=$(printf '%s' "$payload" \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
[ -n "$sid" ] || exit 0

# Kimi's hook payload carries no transcript path; the session index maps
# sessionId -> sessionDir, and the wire.jsonl under it is what the KeepDeck
# usage tailer follows. Best-effort: an index that hasn't recorded this
# session yet just yields a bare binding (identity still works).
transcript=""
index="$HOME/.kimi-code/session_index.jsonl"
if [ -f "$index" ]; then
  sdir=$(grep -F "\"$sid\"" "$index" | tail -n 1 \
    | sed -n 's/.*"sessionDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  [ -n "$sdir" ] && transcript="$sdir/agents/main/wire.jsonl"
fi
if [ -n "$transcript" ]; then
  body=$(printf '{"sessionId":"%s","transcriptPath":"%s"}' "$sid" "$transcript")
else
  body=$(printf '{"sessionId":"%s"}' "$sid")
fi

# Reserve a unique name, write beside the destination, then rename to .json:
# the bridge watcher can never observe a partial envelope.
f=$(mktemp "$dir/session.bound-XXXXXXXX") || exit 0
printf '{"v":1,"type":"session.bound","paneId":"%s","token":"%s","payload":%s}' \
  "$pane" "$token" "$body" > "$f" && mv "$f" "$f.json"
exit 0
