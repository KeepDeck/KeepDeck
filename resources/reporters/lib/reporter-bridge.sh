# Reading what the deck told this pane about itself.
#
# One extractor, one set of names. It was written out three times before this
# file existed — identically, which is the only reason nothing had drifted yet
# — and `url` arriving as a fourth field is exactly the moment a fourth copy
# would have been made.
#
# The values are KeepDeck-minted (uuid-ish, no escapes) and the dir is a path
# without quotes, so pulling quoted JSON strings out with sed is safe here.
field() {
  printf '%s' "$KEEPDECK_BRIDGE" \
    | sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1
}
dir=$(field dir)
pane=$(field pane)
token=$(field token)
# Absent on a deck too old to publish one, or on one whose surface never came
# up. Whole rather than assembled: a reporter that built an address would be a
# second thing to edit the day the route moves.
url=$(field url)
