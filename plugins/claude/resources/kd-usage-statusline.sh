#!/bin/sh
# KeepDeck usage reporter — a Claude Code statusLine command. Claude runs it
# on every status update with the full session JSON on stdin (model, cost,
# context_window, rate_limits, ...). Armed PER SPAWN via the same
# `--settings` injection as the SessionStart hook, so the user's own config
# is never touched.
#
# `--settings` OUTRANKS every settings file on disk, so arming this script
# takes the statusLine slot away from whatever the user configured for
# themselves. Hence three jobs, in this order, all best-effort:
#
#  1. Report: wrap stdin VERBATIM into a bridge `usage.report` envelope —
#     the webview's normalizer owns the statusline schema, this script must
#     never pick fields out of it (a lossy reporter would strip future data).
#     Same tmp + rename publish as the session hook, so the watcher never
#     sees a torn file. FIRST, because claude CANCELS an in-flight statusLine
#     run as soon as the next update arrives: sitting behind a slow user
#     script, the usage chip would starve.
#  2. Delegate: hand the same stdin to the user's OWN statusLine command and
#     pass its stdout through byte for byte (ANSI, OSC 8 links and multiple
#     rows all survive), so a KeepDeck pane renders what their terminal would.
#  3. Footer: only when there is nothing to delegate to — a compact
#     "Model · ctx N%" line, so the pane is never left blank.
#
# Inert without the KeepDeck env; exit 0 always.

payload=$(cat)

# Claude always sends a JSON object. Anything else is not worth a write (the
# bridge would consume-and-drop it) nor a delegated render.
case $payload in
  "{"*) ;;
  *) exit 0 ;;
esac

# ---------------------------------------------------------------- 1. report

# Skipped when we are running INSIDE a delegation (see below): the outer run
# already published this very payload, and a second envelope would double the
# same reading.
if [ -n "$KEEPDECK_BRIDGE" ] && [ -z "$KEEPDECK_STATUSLINE_INNER" ]; then
  # The values are KeepDeck-minted (uuid-ish, no escapes) and the dir is a
  # path without quotes — extracting quoted JSON strings with sed is safe.
  field() {
    printf '%s' "$KEEPDECK_BRIDGE" \
      | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -n 1
  }
  dir=$(field dir)
  pane=$(field pane)
  token=$(field token)
  if [ -n "$dir" ] && [ -n "$pane" ] && [ -n "$token" ]; then
    # mktemp = the unique name AND the tmp stage; the rename to .json
    # publishes.
    if f=$(mktemp "$dir/usage.report-XXXXXXXX"); then
      {
        printf '{"v":1,"type":"usage.report","paneId":"%s","token":"%s","payload":{"agent":"claude","statusline":' \
          "$pane" "$token"
        printf '%s' "$payload"
        printf '}}'
      } > "$f" && mv "$f" "$f.json"
    fi
  fi
fi

# -------------------------------------------------------------- 2. delegate

# Read `<object>.<key>` as a string out of the JSON document on stdin, where
# <object> is a key of the ROOT object. Prints the value, or NOTHING when the
# document is malformed, the field is absent, or its value is not a plain
# string. Every ambiguity is a miss, never a guess: this value decides which
# command we execute, so being wrong here would run the wrong program on the
# user's machine.
#
# Hand-rolled because only POSIX tools are guaranteed on the target machine —
# jq, python and node are all absent from a stock macOS with a native claude
# install. The scan is a character state machine: it tracks string/escape
# state, so a brace or a colon inside a string can never be mistaken for
# structure, and it keys off nesting DEPTH, so a `statusLine` nested somewhere
# else is never confused for the real one.
json_field() {
  awk -v want_obj="$1" -v want_key="$2" '
    { buf = buf $0 "\n" }
    END {
      n = length(buf)
      depth = 0; instr = 0; esc = 0
      tok = ""; last = ""; value = ""
      awaiting = 0; pending = 0; got = 0; bad = 0
      in_obj = 0; obj_depth = 0
      for (i = 1; i <= n && !got && !bad; i++) {
        c = substr(buf, i, 1)
        if (instr) {
          if (esc) {
            # Anything fancier than these three (\n, \t, \uXXXX) means the
            # value is not the plain command-or-path string we expect.
            if (c == "\"" || c == "\\" || c == "/") tok = tok c; else bad = 1
            esc = 0
          } else if (c == "\\") esc = 1
          else if (c == "\"") {
            instr = 0
            if (awaiting) { value = tok; got = 1 } else last = tok
          } else tok = tok c
          continue
        }
        if (c == "\"") { instr = 1; tok = ""; continue }
        if (c == "{") {
          depth++
          if (pending) { in_obj = 1; obj_depth = depth; pending = 0 }
          awaiting = 0
          continue
        }
        if (c == "[") { depth++; pending = 0; awaiting = 0; continue }
        if (c == "}" || c == "]") {
          if (in_obj && depth == obj_depth) in_obj = 0
          depth--; pending = 0; awaiting = 0
          continue
        }
        if (c == ":") {
          if (depth == 1 && last == want_obj) pending = 1
          else if (in_obj && depth == obj_depth && last == want_key) awaiting = 1
          continue
        }
        # A value that is not a string (number, object, true/null) ends the
        # wait without a capture — only plain strings are ever accepted.
        if (c == ",") { awaiting = 0; pending = 0 }
      }
      # A truncated string, a dangling escape or a rejected one means the
      # document is not something to draw conclusions from.
      if (instr || esc || bad) exit 0
      if (got && value != "" && index(value, "\n") == 0) print value
    }
  '
}

# The user's own statusLine — the USER layer only, never claude's full
# precedence chain. A project's `.claude/settings.json` is COMMITTED to the
# repository, so honouring it would mean executing a command chosen by
# whoever wrote the repo, on every clone and every pulled PR branch — and
# claude gates project settings behind a directory-trust prompt whose answer
# we cannot see, so we would be running what the user may have refused.
# Nothing can be sanitized away here: the field IS a command by design, so
# the only workable defence is provenance. Reading just the user's own file
# keeps this to "run what they configured for themselves", which claude would
# have run anyway. Managed settings are not consulted either — they outrank
# `--settings` itself, so where one defines a statusLine this script is not
# running at all.
delegate=""
if [ -z "$KEEPDECK_STATUSLINE_INNER" ]; then
  settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  if [ -f "$settings" ] &&
    [ "$(json_field statusLine type < "$settings")" = "command" ]
  then
    delegate=$(json_field statusLine command < "$settings")
  fi
fi

# Never delegate to ourselves: a user who points their own statusLine at this
# script would otherwise recurse once per update. The env sentinel above
# catches a wrapper AROUND us; this catches the direct reference.
case $delegate in
  *kd-usage-statusline.sh*) delegate="" ;;
esac

if [ -n "$delegate" ]; then
  # Run it the way claude itself would: through a shell, so an inline command
  # and a leading `~` behave exactly as they do outside a KeepDeck pane. Their
  # stderr is left alone. `$(...)` eats trailing newlines; printf puts one back.
  if out=$(printf '%s' "$payload" \
    | KEEPDECK_STATUSLINE_INNER=1 sh -c "$delegate") && [ -n "$out" ]; then
    printf '%s\n' "$out"
    exit 0
  fi
  # Fall through: a delegate that failed or drew nothing would leave the status
  # line blank, so our own footer takes over.
fi

# ---------------------------------------------------------------- 3. footer

# Display-only, so sed is enough here — a missed field costs a character of
# footer, not a wrong decision. `display_name` appears once; `used_percentage`
# is matched inside the flat prefix of the context_window object (it precedes
# the nested current_usage).
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
exit 0
