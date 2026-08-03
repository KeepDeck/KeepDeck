#!/bin/sh
# KeepDeck session reporter — a SessionStart hook shared by Claude Code and
# codex (their hook payloads use the same session_id field; codex copied
# Claude's hooks design). Armed PER SPAWN — claude via `--settings '<json>'`,
# codex via `-c` overrides — so neither agent's user config is ever touched.
#
# Speaks bridge protocol v1: the spawn's single KEEPDECK_BRIDGE env var
# carries {v, dir, pane, token}; the hook payload arrives as JSON on stdin.
# The payload's session_id becomes a `session.bound` envelope dropped into
# the bridge inbox — a uniquely named file (mktemp reserves the name
# atomically, so parallel events never collide) written next to its final
# name and renamed, so the watcher never sees a torn file. SessionStart also
# fires for resume, /clear and compaction, so a mid-life session swap rebinds
# the pane automatically.
#
# Inert without the KeepDeck env; best-effort by design (exit 0 always).

[ -n "$KEEPDECK_BRIDGE" ] || exit 0

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
# session ids are UUIDs — no escapes inside the quoted value, sed is safe.
sid=$(printf '%s' "$payload" \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
[ -n "$sid" ] || exit 0
# The transcript/rollout path rides along when the hook payload carries one —
# codex usage tailing needs it. Unlike the UUID id, a PATH can carry
# JSON-hostile characters: a quote or backslash would corrupt the envelope
# and cost the pane its whole binding — better a bare bind than none.
transcript=$(printf '%s' "$payload" \
  | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
case $transcript in
  *\"*|*\\*) transcript="" ;;
esac
if [ -n "$transcript" ]; then
  body=$(printf '{"sessionId":"%s","transcriptPath":"%s"}' "$sid" "$transcript")
else
  body=$(printf '{"sessionId":"%s"}' "$sid")
fi

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
f=$(mktemp "$dir/session.bound-XXXXXXXX") || exit 0
printf '{"v":1,"type":"session.bound","paneId":"%s","token":"%s","payload":%s}' \
  "$pane" "$token" "$body" > "$f" && mv "$f" "$f.json"
exit 0
