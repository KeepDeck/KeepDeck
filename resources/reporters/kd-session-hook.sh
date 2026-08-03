#!/bin/sh
# KeepDeck session reporter — the SessionStart hook for every CLI that names
# its session in a hook payload (claude, codex and kimi; codex copied
# Claude's hooks design and kimi reuses the same session_id field). Armed PER
# SPAWN — claude via `--settings '<json>'`, codex via `-c` overrides, kimi via
# its companion plugin — so no agent's user config is ever rewritten.
#
# The agent id is $1, exactly as in kd-status-hook.sh: the payload never names
# its own CLI. It matters more here than there, because KEEPDECK_BRIDGE is
# inherited by the pane's WHOLE process tree — a nested agent, or a second
# session of the same one, reports with the pane's own token and would rebind
# the pane to a conversation the user is not having. The deck decides; this
# script's job is to say who is speaking.
#
# `source` rides along unread for the same reason: it is the CLI's own word
# for WHY a session started, and the deck's per-agent normalizer turns it
# into the one bit it needs — a fresh start against a mid-life swap. A CLI
# that reports none simply omits it.
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
# session ids are UUIDs — no escapes inside the quoted value, sed is safe.
sid=$(printf '%s' "$payload" \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
[ -n "$sid" ] || exit 0

# Why the session started, verbatim from the CLI. Kept only when it is a bare
# word: the deck maps it per agent and treats anything it does not recognise
# as the strict case, so a malformed value can widen nothing.
why=$(printf '%s' "$payload" \
  | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
case $why in
  '' | *[!A-Za-z_-]*) why="" ;;
esac

# Where the transcript lives is the one thing these CLIs genuinely disagree
# about, so it is the one thing keyed on the agent.
if [ "$agent" = "kimi" ]; then
  # kimi's hook payload carries no transcript path; the session index maps
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
else
  # The transcript/rollout path rides along when the hook payload carries one —
  # codex usage tailing needs it.
  transcript=$(printf '%s' "$payload" \
    | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)
fi
# Unlike the UUID id, a PATH can carry JSON-hostile characters: a quote or a
# backslash would corrupt the envelope and cost the pane its whole binding —
# better a bare bind than none.
case $transcript in
  *\"*|*\\*) transcript="" ;;
esac

# Assembled field by field rather than one printf per shape: two optional
# fields are already four shapes, and the next one would be eight.
body=$(printf '{"agent":"%s","sessionId":"%s"' "$agent" "$sid")
[ -n "$transcript" ] && body=$(printf '%s,"transcriptPath":"%s"' "$body" "$transcript")
[ -n "$why" ] && body=$(printf '%s,"source":"%s"' "$body" "$why")
body="$body}"

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
f=$(mktemp "$dir/session.bound-XXXXXXXX") || exit 0
printf '{"v":1,"type":"session.bound","paneId":"%s","token":"%s","payload":%s}' \
  "$pane" "$token" "$body" > "$f" && mv "$f" "$f.json"
exit 0
