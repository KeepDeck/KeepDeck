# shellcheck shell=sh
# WHICH process is reporting — the process GROUP of the hook's parent.
#
# The bridge secret proves only "something under this pane", and the deck's
# door checks that the process named here belongs to the pane's terminal —
# within it, this is the sender's word, which tells the agent from a nested
# CLI that inherited the environment and names its own group. It is measured
# rather than assumed: across one agent process every hook
# invocation reports the same group (the agent leads it), while a CLI started
# from a tool call lands in the group that call created and reports another.
# The hook's OWN group is useless here — agents spawn hooks detached, so it is
# unique per invocation.
#
# Best-effort like everything else: a `ps` that cannot answer yields no field,
# and the deck falls back to the rules that do not need one.
reporter=$(ps -o pgid= -p "$PPID" 2>/dev/null)
# `ps` pads the column; trimmed in place rather than by one more process.
reporter=${reporter#"${reporter%%[![:space:]]*}"}
reporter=${reporter%"${reporter##*[![:space:]]}"}
case $reporter in
  '' | *[!0-9]*) reporter="" ;;
esac
# Deliberately no fallback when it is empty: guessing an identity is worse
# than admitting there is none, since the deck reads a wrong one as a
# DIFFERENT process and would lock a pane out of its own conversation.
