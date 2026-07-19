#!/bin/sh
# KeepDeck usage reporter — a Claude Code statusLine command. Claude runs it
# on every status update with the full session JSON on stdin (model, cost,
# context_window, rate_limits, ...). Armed PER SPAWN via the same
# `--settings` injection as the SessionStart hook, so the user's own config
# file is never written.
#
# `--settings` outranks every settings file a user edits (a managed policy
# still wins), so arming this takes the statusLine slot away from whatever the
# user configured for themselves. Three jobs give it back, in this order, all
# best-effort:
#
#  1. Report: wrap stdin VERBATIM into a bridge `usage.report` envelope — the
#     webview's normalizer owns the statusline schema, so this script must
#     never pick fields out of it (a lossy reporter would strip future data).
#     Same tmp + rename publish as the session hook. FIRST, because claude
#     CANCELS an in-flight statusLine run the moment the next update arrives:
#     behind a slow user script the usage chip would starve. Needs the bridge
#     env; the other two jobs do not.
#  2. Delegate: resolve the statusLine the user configured for THEMSELVES and
#     run it on the same stdin, passing its stdout through byte for byte (ANSI,
#     OSC 8 links and extra rows all survive), so a KeepDeck pane renders the
#     status line they chose.
#  3. Footer: only when there is nothing to delegate to — a compact
#     "Model · ctx N%" line, so the pane is never left blank.
#
# Always exits 0.

payload=$(cat)

# Claude sends a compact JSON object; tolerate leading whitespace so one stray
# byte (a wrapper, a locale quirk) does not blank the row AND starve the
# report. `$payload` stays verbatim for the envelope and the delegate — only
# the shape check is trimmed. Anything that is not an object is dropped: the
# bridge would consume-and-drop it, and it is nothing to delegate on.
trimmed=${payload#"${payload%%[![:space:]]*}"}
case $trimmed in
  "{"*) ;;
  *) exit 0 ;;
esac

# ---------------------------------------------------------------- 1. report

# Skipped when we are running INSIDE a delegation (see below): the outer run
# already published this very payload, and a second envelope would double the
# same reading.
if [ -n "$KEEPDECK_BRIDGE" ] && [ -z "$KEEPDECK_STATUSLINE_NESTED" ]; then
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

# WHY THIS LIVES IN THE SCRIPT, NOT THE PLUGIN'S TYPESCRIPT: resolving the
# user's statusLine means reading `~/.claude/settings.json`, which the plugin
# realm (sandboxed, no home-dir capability) cannot reach. This reporter is a
# subprocess claude runs with the user's own privileges, so it reads the file
# directly — no new capability, and edits take effect on the next update. The
# cost is the hand-rolled JSON reader below, because only POSIX tools are
# guaranteed here (jq, python and node are all absent from a stock macOS with
# a native claude install).

# The command from the user's OWN root-level `statusLine`, printed only when
# it is `{ "type": "command", "command": "<plain string>" }` in a well-formed
# file — otherwise nothing. Every ambiguity is a miss, never a guess: this
# value is executed, so a wrong read would run the wrong program.
#
# One pass of a character state machine over the whole document:
#  - string/escape state is tracked, so a brace or colon inside a string is
#    never mistaken for structure;
#  - it keys off nesting DEPTH, so only the ROOT statusLine counts, never one
#    nested under another key nor a `command` inside a deeper object/array;
#  - a later duplicate key overwrites an earlier one, matching JSON's
#    last-wins, so the chosen command is the one claude's own parser would use;
#  - the scan runs to EOF and requires the braces to balance, so a file
#    truncated mid-write (which claude rejects outright) yields nothing rather
#    than a half-captured command;
#  - a control-char escape (\n, \t, \uXXXX, ...) — anything but \" \\ \/ —
#    TAINTS ONLY the value it sits in, so a multi-line hook command elsewhere
#    in the file no longer suppresses delegation for the whole document.
user_statusline_command() {
  awk '
    { buf = buf $0 "\n" }
    END {
      n = length(buf)
      depth = 0; instr = 0; esc = 0
      tok = ""; tok_bad = 0; last = ""
      sl_pending = 0; in_sl = 0; sl_depth = 0
      awaiting = ""
      type_ok = 0; type_val = ""; cmd_ok = 0; cmd_val = ""
      for (i = 1; i <= n; i++) {
        c = substr(buf, i, 1)
        if (instr) {
          if (esc) {
            if (c == "\"" || c == "\\" || c == "/") tok = tok c
            else tok_bad = 1
            esc = 0
          } else if (c == "\\") esc = 1
          else if (c == "\"") {
            instr = 0
            if (awaiting != "") {
              if (!tok_bad) {
                if (awaiting == "type") { type_val = tok; type_ok = 1 }
                else { cmd_val = tok; cmd_ok = 1 }
              }
              awaiting = ""
            } else last = tok
          } else tok = tok c
          continue
        }
        if (c == "\"") { instr = 1; tok = ""; tok_bad = 0; continue }
        if (c == "{") {
          depth++
          # A new root-level statusLine object resets any earlier capture, so
          # the LAST such object wins (JSON last-wins for a duplicated key).
          if (sl_pending) {
            in_sl = 1; sl_depth = depth
            type_ok = 0; type_val = ""; cmd_ok = 0; cmd_val = ""
            sl_pending = 0
          }
          awaiting = ""
          continue
        }
        if (c == "[") { depth++; sl_pending = 0; awaiting = ""; continue }
        if (c == "}" || c == "]") {
          if (in_sl && depth == sl_depth) in_sl = 0
          depth--; sl_pending = 0; awaiting = ""
          continue
        }
        if (c == ":") {
          if (depth == 1 && last == "statusLine") sl_pending = 1
          else if (in_sl && depth == sl_depth) {
            # Re-arm on every occurrence and clear the prior capture, so a
            # later duplicate key (or a non-string value) wins last, like JSON.
            if (last == "type") { awaiting = "type"; type_ok = 0 }
            else if (last == "command") { awaiting = "command"; cmd_ok = 0 }
          }
          continue
        }
        # A non-string value (number, object, true/null) ends the wait with no
        # capture — only plain strings are ever accepted.
        if (c == ",") { awaiting = ""; sl_pending = 0 }
      }
      # A truncated string, a dangling escape, or unbalanced braces means the
      # document is not something to draw a command from.
      if (instr || esc || depth != 0) exit 0
      if (type_ok && type_val == "command" && cmd_ok && cmd_val != "" \
          && index(cmd_val, "\n") == 0 && index(cmd_val, "\r") == 0)
        print cmd_val
    }
  '
}

# The user's own statusLine — the USER layer only, never claude's full
# precedence chain. A project's `.claude/settings.json` is COMMITTED to the
# repository, so honouring it would mean executing a command chosen by whoever
# wrote the repo, on every clone and every pulled PR branch — and claude gates
# project settings behind a directory-trust prompt whose answer we cannot see,
# so we would be running what the user may have refused. Nothing can be
# sanitized away here: the field IS a command by design, so the only workable
# defence is provenance. Reading just the user's own file keeps this to "run
# what they configured for themselves". Managed settings are not consulted
# either — they outrank `--settings` itself, so where one defines a statusLine
# this script is not running at all.
delegate=""
if [ -z "$KEEPDECK_STATUSLINE_NESTED" ]; then
  settings="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
  [ -f "$settings" ] && delegate=$(user_statusline_command < "$settings")
fi

# Never delegate to ourselves. The NESTED sentinel below stops a user script
# that WRAPS this reporter from recursing; this substring check stops a direct
# reference by path. (A wrapper that BOTH strips the environment AND avoids
# naming this script by path is the one uncovered case — a deliberately
# pathological setup; POSIX offers no further guard without external state.)
case $delegate in
  *kd-usage-statusline.sh*) delegate="" ;;
esac

if [ -n "$delegate" ]; then
  # Capture BOTH streams to files, never `$(...)`. Two reasons, both about a
  # delegate that backgrounds a refresh job (the standard "print the cached
  # line, refresh async" pattern):
  #  - command substitution blocks until every descendant closes the pipe, so
  #    the whole reporter would hang for the background job's lifetime;
  #  - even with the pipe gone, a background child inherits our fd 1 AND fd 2,
  #    which are claude's captured pipes — claude would then block draining
  #    them. Redirecting to files means the child holds files, not claude.
  # Files also keep stdout byte for byte (`$(...)` eats trailing blank rows).
  # The delegate's stderr is replayed to ours afterwards, so a user debugging
  # their own statusLine still sees it. Run under /bin/sh, the interpreter
  # KeepDeck runs this reporter under, so the delegate behaves the same inside
  # a pane as out. The NESTED sentinel guards the report and the delegation
  # against a user script that wraps this one.
  out=$(mktemp "${TMPDIR:-/tmp}/kd-statusline-XXXXXXXX") || out=""
  err=$(mktemp "${TMPDIR:-/tmp}/kd-statusline-XXXXXXXX") || err=""
  if [ -n "$out" ] && [ -n "$err" ]; then
    if printf '%s' "$payload" \
      | KEEPDECK_STATUSLINE_NESTED=1 /bin/sh -c "$delegate" > "$out" 2> "$err" \
      && [ -s "$out" ]
    then
      cat "$err" >&2
      cat "$out"
      rm -f "$out" "$err"
      exit 0
    fi
    cat "$err" >&2
  fi
  # A delegate that failed, drew nothing, or could not be staged falls through
  # to our own footer, so the row is never left blank.
  [ -n "$out" ] && rm -f "$out"
  [ -n "$err" ] && rm -f "$err"
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
