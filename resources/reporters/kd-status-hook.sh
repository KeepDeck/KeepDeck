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

# `--ask` turns this from a statement into a QUESTION: the same envelope
# also asks the deck whether anything is waiting for this pane, and the
# answer is printed for the CLI to act on.
#
# Armed per EVENT, not per agent: only a turn boundary can carry a reply,
# and asking on every PostToolUse would be a round trip per tool call. The
# arming site knows which event it is arming; this script deliberately does
# not read the payload, so the flag comes in on argv beside the agent id —
# the same reason the agent id is there.
#
# One envelope for both, deliberately. The deck's answer depends on the
# status it is being told about in the same breath, and two envelopes would
# let those be read in either order — the pane could be marked finished by
# one while the other was still deciding to keep it running.
ask=""
[ "$2" = "--ask" ] && ask="yes"

# How long to wait for the deck.
#
# This was cut to 600ms on a guess — that a hook holding a shutting-down CLI
# open was why codex could not resume a thread with "an active writer". The
# guess was never tested, and the cut broke delivery that WORKED: the host
# books a message the moment it hands it over, so a hook that gives up first
# leaves it marked delivered and unread in the inbox. Claude stopped picking
# up its context, and the message sat there. Two seconds is what worked.
#
# The real fix is not a number. The hook removes the reply file once it has
# read it, so a file still sitting there means nobody took the message — the
# host can check that and put it back in the queue instead of believing its
# own hand-over. Until then, do NOT shorten this: a slow round trip is a
# delayed message, a short window is a lost one.
ASK_TRIES=40
ASK_SLEEP=0.05
# The same patience on the direct lane, spent WAITING rather than polling —
# one number for one rule, so the two lanes cannot disagree about how long a
# deck gets to answer. Kept slightly over the poll budget: the deck's own
# side of the rendezvous times out first, and the answer to a question should
# come from the deck, not from whoever gave up sooner.
ASK_MAX=3

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
# Absent on an older deck, or on one whose surface never came up. Whole, not
# assembled: this script does not know the route and must not learn it.
url=$(field url)
[ -n "$dir" ] && [ -n "$pane" ] && [ -n "$token" ] || exit 0

# @include lib/reporter-identity.sh

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

# The correlation the deck answers on: 64 random bits, minted WITHOUT
# touching the filesystem.
#
# It used to be an `mktemp` in the inbox, which minted the name and reserved
# it in one step. The reservation was the problem: it announced, for the whole
# two seconds this hook then waits, the exact filename the deck was about to
# write and this script would `cat` verbatim into the CLI. Anything else on
# the machine could read that name and put its own text there first. Panes run
# as one OS user, so nothing stops a process reading this directory — but a
# name it cannot learn until the answer already exists is a far narrower
# window than a name posted in advance.
#
# Alphanumeric on purpose: the deck refuses a correlation that could not
# safely become a filename, and a rejected one would just time out below for
# no reason. Collision needs no reservation at 64 bits.
correlation=""
if [ -n "$ask" ]; then
  correlation=ask$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  # No usable randomness (no /dev/urandom, no od): fall back to the reserved
  # name. Announced, and better than an agent that stops receiving mail.
  if [ "$correlation" = "ask" ]; then
    reserved=$(mktemp "$dir/askXXXXXXXX" 2>/dev/null) && correlation=${reserved##*/}
  fi
fi

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
# The trap reaps the staging file if this process is killed mid-write (kimi
# enforces a hook timeout with a signal) — after a successful mv there is
# nothing at $f and the rm is a no-op. The inbox never sweeps strays itself.
trap 'rm -f ${f:+"$f"} ${reserved:+"$reserved"}' EXIT INT TERM
# The host-owned keys that may or may not be there, built as one fragment so
# the envelope stays a SINGLE printf. A branch per combination would be four
# copies of one line, in a file three plugins carry byte-for-byte.
#
# `reporter` — WHICH process is reporting: the pane's identity is pinned to
# one process, and a report from another is somebody else's numbers no matter
# how correct its secret and agent are.
# `reply` — the correlation the deck answers on, present only when asking.
extra=""
[ -n "$reporter" ] && extra="$extra\"reporter\":\"$reporter\","
[ -n "$correlation" ] && extra="$extra\"reply\":\"$correlation\","
envelope=$(printf '{"v":1,"type":"agent.status","paneId":"%s","token":"%s","payload":{"agent":"%s",%s"event":%s}}' \
  "$pane" "$token" "$agent" "$extra" "$payload")

# THE DIRECT LANE. Try the deck's own address first; fall back to the inbox
# only when the connection never happened. `curl` is the one client that can
# be relied on here: `nc` on macOS races its own stdin EOF and leaves without
# waiting, and there is no flag to stop it.
#
# The status code decides, and the three cases are genuinely different:
#   200 — an answer, possibly empty. Empty means nothing was waiting, which
#         loses nothing, so printing nothing is correct.
#   504 — the deck took the envelope and never answered. NOT a retry: writing
#         a file now would deliver the same report twice.
#   anything else, or no code at all — the deck never heard us. The inbox is
#         still there, and that is what it is for.
if [ -n "$url" ] && command -v curl >/dev/null 2>&1; then
  answer=$(printf '%s' "$envelope" \
    | curl -s --max-time "$ASK_MAX" -w '\n%{http_code}' \
        -X POST --data-binary @- "$url" 2>/dev/null)
  code=$(printf '%s' "$answer" | tail -n 1)
  case "$code" in
    200)
      # Printed verbatim, exactly as the file lane prints it: the deck
      # rendered this through the agent's own plugin and the schema is the
      # CLI's, not this script's.
      printf '%s' "$answer" | sed '$d'
      exit 0
      ;;
    204|504)
      exit 0
      ;;
  esac
fi

# mktemp = the unique name AND the tmp stage; the rename to .json publishes.
f=$(mktemp "$dir/agent.status-XXXXXXXX" 2>/dev/null) || exit 0
printf '%s' "$envelope" > "$f" && mv "$f" "$f.json"

# Wait for the answer, if one was asked for. Everything about this loop is
# built to FAIL OPEN: a deck that has quit, a reply that never comes, a
# `sleep` that cannot take a fraction — each ends the same way, silently and
# with nothing printed, which every CLI reads as "the hook had nothing to
# add". The alternative failure, a hook that hangs, holds up the CLI itself.
if [ -n "$correlation" ]; then
  reply="$dir/$correlation.reply"
  tries=$ASK_TRIES
  while [ "$tries" -gt 0 ]; do
    if [ -f "$reply" ]; then
      # Printed verbatim: the deck rendered it through this agent's own
      # plugin, so the schema is the CLI's and this script stays ignorant
      # of it — the same division it keeps for payloads on the way in.
      cat "$reply" 2>/dev/null
      rm -f "$reply"
      break
    fi
    sleep "$ASK_SLEEP" 2>/dev/null
    tries=$((tries - 1))
  done
fi
exit 0
