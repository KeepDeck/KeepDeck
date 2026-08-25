# Reading what the deck told this pane about itself.
#
# One extractor, one set of names. It was written out three times before this
# file existed — identically, which is the only reason nothing had drifted yet
# — and `url` arriving as a fourth field is exactly the moment a fourth copy
# would have been made.
#
# The values are minted by KeepDeck, so the sed below is safe on them.
field() {
  printf '%s' "$KEEPDECK_BRIDGE" \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}
pane=$(field pane)
token=$(field token)
# Whole rather than assembled: a reporter that built an address would be a
# second thing to edit the day the route moves. Empty means the deck's surface
# never came up, and since the cutoff that means there is nowhere to report —
# `dir` is still in the env, but it now holds nothing but a doorbell, which
# only an in-process reporter watches.
url=$(field url)
