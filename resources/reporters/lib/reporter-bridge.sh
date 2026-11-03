# shellcheck shell=sh
# Reading what the deck told this pane about itself.
#
# One extractor, one set of names. It was written out three times before this
# file existed — identically, which is the only reason nothing had drifted yet
# — and `url` arriving as a fourth field is exactly the moment a fourth copy
# would have been made.
#
# The values are minted by KeepDeck as plain strings, so the text between
# the quotes after a key is the value. Read with parameter expansion, never a
# pipeline: a statusline runs this on every status update, and three fields
# read through `printf | sed | head` were a dozen processes a tick for values
# that never change in a pane's life.
#
# field <key> sets `field_value` to the string value of the LAST `"key"` —
# KeepDeck writes each key once — or to empty when the key is absent or its
# value is not a string.
field() {
  field_value=""
  field_rest=${KEEPDECK_BRIDGE##*"\"$1\""}
  [ "$field_rest" = "$KEEPDECK_BRIDGE" ] && return 0
  # Between the key and the value's opening quote: one colon, and spaces.
  field_gap=${field_rest%%\"*}
  [ "$field_gap" = "$field_rest" ] && return 0
  case $field_gap in
    *:*:* | *[![:space:]:]*) return 0 ;;
    *:*) ;;
    *) return 0 ;;
  esac
  field_rest=${field_rest#*\"}
  case $field_rest in
    *\"*) field_value=${field_rest%%\"*} ;;
  esac
}
field pane
pane=$field_value
field token
token=$field_value
# Whole rather than assembled: a reporter that built an address would be a
# second thing to edit the day the route moves. Empty means the deck's surface
# never came up, and since the cutoff that means there is nowhere to report —
# `dir` is still in the env, but it now holds nothing but a doorbell, which
# only an in-process reporter watches.
field url
url=$field_value
