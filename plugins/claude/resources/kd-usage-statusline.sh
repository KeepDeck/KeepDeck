#!/bin/sh
# KeepDeck usage reporter — a Claude Code statusLine command. Claude runs it
# on every status update with the full session JSON on stdin (model, cost,
# context_window, rate_limits, ...). Armed PER SPAWN via the same
# `--settings` injection as the SessionStart hook, so the user's own config
# is never touched.
#
# Two jobs, both best-effort:
#  1. Report: wrap stdin VERBATIM into a bridge `usage.report` envelope —
#     the webview's normalizer owns the statusline schema, this script must
#     never pick fields out of it (a lossy reporter would strip future data).
#     Same tmp + rename publish as the session hook, so the watcher never
#     sees a torn file.
#  2. Footer: print a compact "Model · ctx N%" line for the pane's TUI —
#     the statusLine renders in its own row above claude's built-in badges.
#
# Inert without the KeepDeck env; exit 0 always.

payload=$(cat)

# The footer works even when the bridge is gone — extraction is display-only.
# `display_name` appears once; `used_percentage` is matched inside the flat
# prefix of the context_window object (it precedes the nested current_usage).
model=$(printf '%s' "$payload" \
  | sed -n 's/.*"display_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
ctx=$(printf '%s' "$payload" \
  | sed -n 's/.*"context_window"[[:space:]]*:[[:space:]]*{[^{}]*"used_percentage"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
  | head -n 1)
if [ -n "$model" ] && [ -n "$ctx" ]; then
  printf '%s · ctx %s%%\n' "$model" "$ctx"
elif [ -n "$model" ]; then
  printf '%s\n' "$model"
fi

[ -n "$KEEPDECK_BRIDGE" ] || exit 0
# A statusline payload is a JSON object; anything else is not worth a write
# (the bridge would consume-and-drop it anyway).
case $payload in
  "{"*) ;;
  *) exit 0 ;;
esac

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

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
f=$(mktemp "$dir/usage.report-XXXXXXXX") || exit 0
{
  printf '{"v":1,"type":"usage.report","paneId":"%s","token":"%s","payload":{"agent":"claude","statusline":' \
    "$pane" "$token"
  printf '%s' "$payload"
  printf '}}'
} > "$f" && mv "$f" "$f.json"
exit 0
