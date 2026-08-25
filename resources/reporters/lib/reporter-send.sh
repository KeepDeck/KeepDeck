# Handing one envelope to the deck.
#
# One lane. There used to be two — this one, and dropping a file in a
# directory the deck watched — and the file was not a fallback in the sense
# of "the worse option we keep around": it was the whole transport first, and
# the only lane a deck too old to publish an address had. It is gone, and with
# it the reason a reporter had to know how to write an inbox at all.
#
# Needs `url` in scope, read from KEEPDECK_BRIDGE by the caller. Empty means
# the deck published no address, which after the cutoff means there is nowhere
# to report: silent, because a hook that printed a complaint would print it
# into the agent's own transcript on every turn.
#
# `curl` is the one client that can be relied on here. `nc` on macOS races its
# own stdin EOF and leaves without waiting for a reply, and there is no flag
# that stops it doing so.

# How long to give the whole round trip.
#
# Deliberately LONGER than the deck's own patience (`HOOK_WAIT` in
# bridge/waiters.rs), so the deck runs out first and answers 504 rather than
# leaving this side to time out against a silent socket. An answer about a
# question should come from the deck, not from whichever end gave up sooner.
# `scripts/reporterScripts.test.mjs` pins that ordering.
SEND_MAX=3

# send_envelope <envelope>
#
# Prints the deck's answer when there is one, and nothing at all otherwise —
# so a caller with no question to ask can ignore the output entirely.
#
# It took a `kind` until the cutoff, and that argument was the inbox filename
# — the envelope has always carried its own `type`.
#
# The status code decides:
#   200 — an answer with something in it. Printed verbatim: the deck rendered
#         it through the asking agent's own plugin, so the schema is that
#         CLI's and this function stays ignorant of it.
#   204 — heard, and there was nothing to say back. The common case.
#   409 — this correlation is already in flight. Only a reporter that reused
#         one gets this, and printing nothing is right: the ask that holds
#         the slot is the one being answered.
#   504 — heard, and the deck never answered in time.
# Anything else, or no code at all, means the deck never heard us. There is
# nothing to be done about it here either way, which is why every arm ends
# the same: silence, which every CLI reads as "the hook had nothing to add".
send_envelope() {
  send_body=$1
  [ -n "$url" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  send_answer=$(printf '%s' "$send_body" \
    | curl -s --max-time "$SEND_MAX" -w '\n%{http_code}' \
        -X POST --data-binary @- "$url" 2>/dev/null)
  case "$(printf '%s' "$send_answer" | tail -n 1)" in
    200) printf '%s' "$send_answer" | sed '$d' ;;
  esac
  return 0
}
