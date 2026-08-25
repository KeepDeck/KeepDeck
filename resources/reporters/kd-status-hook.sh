#!/bin/sh
# KeepDeck status reporter — a hook shared by the turn-lifecycle events
# (UserPromptSubmit / Stop / StopFailure / Notification / PostToolUse and
# their codex/kimi equivalents). Armed PER SPAWN beside kd-session-hook.sh;
# the agent id is
# $1 because the payload does not name its CLI and the webview dispatches
# normalizers by agent.
#
# Speaks bridge protocol v2: the whole hook payload (JSON on stdin) rides
# VERBATIM under payload.event — no field extraction, so this script never
# chases a CLI's schema. Posted to the deck, which answers on the same
# connection when this hook asked a question.
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

# How long this hook waits for the deck is no longer decided here: the answer
# comes back on the connection the envelope went out on, so it is the round
# trip's own timeout (`SEND_MAX`, in the sender below).
#
# Worth keeping the history, because the number was got wrong once in a way
# that looked like something else. It was cut to 600ms on a guess — that a
# hook holding a shutting-down CLI open was why codex could not resume a
# thread with "an active writer". The guess was never tested, and the cut
# broke delivery that WORKED: the deck hands a message over the moment it
# answers, so a hook that gave up first left it marked delivered and unread.
# Claude stopped picking up its context and the message sat there.
#
# What made that failure silent is gone. The deck learns from the send itself
# whether the hook was still there, and puts the messages back when it was
# not — so a window that is too short is now a delayed message rather than a
# lost one.

# @include lib/reporter-bridge.sh
# `url` rather than `dir`: this reporter has not written a file since the
# cutoff, and a pane whose deck published no address has nowhere to report.
[ -n "$url" ] && [ -n "$pane" ] && [ -n "$token" ] || exit 0

# @include lib/reporter-identity.sh

# @include lib/reporter-send.sh

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
# it in one step. The reservation was the problem: it announced, for as long
# as this hook then waited, the exact filename the deck was about to write and
# this script would print verbatim into the CLI. Anything else on the machine
# could read that name and put its own text there first. There is no file to
# race for any more — the answer arrives on this process's own connection —
# but the name still has to be unique, and randomness is the cheapest way.
#
# Alphanumeric on purpose: the deck refuses a correlation it could not have
# used as a filename, and a rejected one would just go unanswered.
correlation=""
if [ -n "$ask" ]; then
  correlation=ask$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  # No usable randomness (no /dev/urandom, no od). The pid plus the clock is
  # not secret, and no longer needs to be: it only has to be different from
  # this pane's other asks, and a pane asks once per turn boundary.
  [ "$correlation" = "ask" ] && correlation="ask$$_$(date +%s 2>/dev/null)"
fi

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
envelope=$(printf '{"v":2,"type":"agent.status","paneId":"%s","token":"%s","payload":{"agent":"%s",%s"event":%s}}' \
  "$pane" "$token" "$agent" "$extra" "$payload")

# Sent, and ANSWERED on the same connection when an answer was asked for:
# `send_envelope` prints the deck's reply and nothing otherwise, so there is
# no loop here to fail open. What this used to be — poll a directory for a
# file, print it, remove it, give up after forty tries — was two seconds of
# guessing at a question the connection answers by existing.
send_envelope "$envelope"
exit 0
