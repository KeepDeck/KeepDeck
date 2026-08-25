# Handing one envelope to the deck, whichever way it can be reached.
#
# Two lanes, and the direct one is tried first. The inbox is not a fallback in
# the sense of "the worse option we keep around" — it is the only lane a deck
# too old to publish an address has, and the only lane left when the address
# is there but nothing answers on it. Both are normal.
#
# Needs `url` and `dir` in scope, both read from KEEPDECK_BRIDGE by the caller:
# `url` may be empty (an older deck, or a surface that never came up), `dir`
# never is — a reporter with no inbox has already exited.
#
# `curl` is the one client that can be relied on here. `nc` on macOS races its
# own stdin EOF and leaves without waiting for a reply, and there is no flag
# that stops it doing so.

# How long the deck gets to answer. Kept slightly over the poll budget the
# inbox lane uses, so the deck's own side of a rendezvous times out first: an
# answer to a question should come from the deck rather than from whichever
# side gave up sooner.
SEND_MAX=3

# send_envelope <kind> <envelope>
#
# Prints the deck's answer when there is one, and nothing at all otherwise —
# so a caller with no question to ask can ignore the output entirely.
#
# The status code decides, and the three cases are genuinely different:
#   200 — an answer with something in it. Printed verbatim: the deck rendered
#         it through the asking agent's own plugin, so the schema is that
#         CLI's and this function stays ignorant of it.
#   204 — heard, and there was nothing to say back. The common case.
#   504 — heard, and the deck never answered in time. NOT a retry: writing a
#         file now would deliver the same envelope twice.
# Anything else, or no code at all, means the deck never heard us — and that
# is what the inbox is for.
send_envelope() {
  send_kind=$1
  send_body=$2
  if [ -n "$url" ] && command -v curl >/dev/null 2>&1; then
    send_answer=$(printf '%s' "$send_body" \
      | curl -s --max-time "$SEND_MAX" -w '\n%{http_code}' \
          -X POST --data-binary @- "$url" 2>/dev/null)
    case "$(printf '%s' "$send_answer" | tail -n 1)" in
      200)
        printf '%s' "$send_answer" | sed '$d'
        return 0
        ;;
      204 | 504)
        return 0
        ;;
    esac
  fi
  # mktemp = the unique name AND the tmp stage; the rename to .json publishes.
  # `send_file` is global on purpose: a caller that set a trap before calling
  # reaps the staging file if this process is killed mid-write.
  send_file=$(mktemp "$dir/$send_kind-XXXXXXXX" 2>/dev/null) || return 0
  printf '%s' "$send_body" > "$send_file" && mv "$send_file" "$send_file.json"
  return 0
}
