#!/bin/sh
# KeepDeck codex session reporter — a SessionStart hook, armed PER SPAWN via
# `-c` overrides (nothing is written to the user's ~/.codex). codex runs it
# through `$SHELL -lc`, piping the hook payload JSON to stdin; the payload's
# session_id plus the env-injected pane id become a spool postback KeepDeck's
# watcher turns into a binding. SessionStart also fires for resume/clear, so
# a mid-life /clear rebinds the pane to its new session automatically.
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
f="$KEEPDECK_SPOOL/$KEEPDECK_PANE_ID-$$-codex"
printf '{"paneId":"%s","sessionId":"%s","agent":"codex"}' \
  "$KEEPDECK_PANE_ID" "$sid" > "$f.tmp" && mv "$f.tmp" "$f.json"
exit 0
