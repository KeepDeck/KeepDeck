#!/bin/sh
# KeepDeck session reporter — a SessionStart hook shared by Claude Code and
# codex (their hook payloads use the same session_id field; codex copied
# Claude's hooks design). Armed PER SPAWN — claude via `--settings '<json>'`,
# codex via `-c` overrides — so neither agent's user config is ever touched.
# The agent runs it with the hook payload JSON on stdin; the payload's
# session_id plus the env-injected pane id become a spool postback KeepDeck's
# watcher turns into a binding. SessionStart also fires for resume, /clear and
# compaction, so a mid-life session swap rebinds the pane automatically.
#
# Inert without the KeepDeck env; best-effort by design (exit 0 always).

[ -n "$KEEPDECK_PANE_ID" ] && [ -n "$KEEPDECK_SPOOL" ] || exit 0

payload=$(cat)
# session ids are UUIDs — no escapes inside the quoted value, sed is safe.
sid=$(printf '%s' "$payload" \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
[ -n "$sid" ] || exit 0

# tmp + mv so the spool watcher never sees a torn file.
f="$KEEPDECK_SPOOL/$KEEPDECK_PANE_ID-$$"
printf '{"paneId":"%s","sessionId":"%s"}' \
  "$KEEPDECK_PANE_ID" "$sid" > "$f.tmp" && mv "$f.tmp" "$f.json"
exit 0
