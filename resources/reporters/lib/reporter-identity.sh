# WHICH process is reporting — the process GROUP of the hook's parent.
#
# The bridge secret proves only "something under this pane", so the deck needs
# a value a nested CLI cannot forge by inheriting the environment. This is it,
# and it is measured rather than assumed: across one agent process every hook
# invocation reports the same group (the agent leads it), while a CLI started
# from a tool call lands in the group that call created and reports another.
# The hook's OWN group is useless here — agents spawn hooks detached, so it is
# unique per invocation.
#
# Best-effort like everything else: a `ps` that cannot answer yields no field,
# and the deck falls back to the rules that do not need one.
reporter=$(ps -o pgid= -p "$PPID" 2>/dev/null | tr -d ' ')
case $reporter in
  '' | *[!0-9]*) reporter="" ;;
esac
