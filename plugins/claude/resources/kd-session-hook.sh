#!/bin/sh
# GENERATED from resources/reporters/kd-session-hook.sh — do not edit this copy.
# Edit the canonical file and run `node scripts/sync-reporters.mjs`;
# scripts/reporterScripts.test.mjs fails while a copy is stale.
# KeepDeck session reporter — the SessionStart hook for every CLI that names
# its session in a hook payload (claude, codex and kimi; codex copied
# Claude's hooks design and kimi reuses the same session_id field). Armed PER
# SPAWN — claude via `--settings '<json>'`, codex via `-c` overrides, kimi via
# its companion plugin — so no agent's user config is ever rewritten.
#
# The agent id is $1, exactly as in kd-status-hook.sh: the payload never names
# its own CLI. It matters more here than there, because KEEPDECK_BRIDGE is
# inherited by the pane's WHOLE process tree — a nested agent, or a second
# session of the same one, reports with the pane's own token and would rebind
# the pane to a conversation the user is not having. The deck decides; this
# script's job is to say who is speaking.
#
# `source` rides along unread for the same reason: it is the CLI's own word
# for WHY a session started, and the deck's per-agent normalizer turns it
# into the one bit it needs — a fresh start against a mid-life swap. A CLI
# that reports none simply omits it.
#
# Speaks bridge protocol v1: the spawn's single KEEPDECK_BRIDGE env var
# carries {v, dir, pane, token}; the hook payload arrives as JSON on stdin.
# The payload's session_id becomes a `session.bound` envelope dropped into
# the bridge inbox — a uniquely named file (mktemp reserves the name
# atomically, so parallel events never collide) written next to its final
# name and renamed, so the watcher never sees a torn file. SessionStart also
# fires for resume, /clear and compaction, so a mid-life session swap rebinds
# the pane automatically.
#
# Inert without the KeepDeck env; best-effort by design (exit 0 always).

[ -n "$KEEPDECK_BRIDGE" ] || exit 0
agent="$1"
[ -n "$agent" ] || exit 0
# Ours by construction (the three arming sites pass literals), guarded anyway:
# it is interpolated into the envelope exactly like the fields that are not.
case $agent in
  *\"*|*\\*) exit 0 ;;
esac

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
[ -n "$dir" ] && [ -n "$pane" ] && [ -n "$token" ] || exit 0

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
# Deliberately no fallback when it is empty: guessing an identity is worse
# than admitting there is none, since the deck reads a wrong one as a
# DIFFERENT process and would lock a pane out of its own conversation.

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

payload=$(cat)
# session ids are UUIDs — no escapes inside the quoted value, sed is safe.
sid=$(printf '%s' "$payload" \
  | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  | head -n 1)
[ -n "$sid" ] || exit 0
# The id is the one field with no bare fallback — an envelope carrying a quote
# or a backslash here closes mid-string, and the bridge drops the whole thing
# unread. Saying nothing is the same outcome without the garbage in the inbox.
case $sid in
  *\"*|*\\*) exit 0 ;;
esac

# Why the session started, verbatim from the CLI.
#
# The FIRST match, never sed's greedy last — `"source"` is a far more generic
# key than `session_id`, hook payloads are compact single-line JSON, and a
# later occurrence in nested tool JSON would otherwise win. Getting this
# backwards is not symmetric: an inner `"resume"` overriding a real `startup`
# reads as a CONTINUATION, which is exactly the rebind the deck refuses on a
# fresh session. Same reasoning, same shape as kd-status-hook.sh's event-name
# reduction. `\n\r` are flattened first because grep is line-oriented while
# JSON whitespace is not.
#
# What this still cannot see is nesting: a payload whose ONLY `"source"` sits
# inside a nested object reports that value. No agent we arm produces one —
# every SessionStart carries a top-level source, which document order then
# picks — and the residue is bounded by the process pin, which refuses a
# rebind from anywhere but the process that bound the generation, whatever
# word it brings. Teaching sed to parse JSON would cost more than it buys.
why=$(printf '%s' "$payload" \
  | tr '\n\r' '  ' 2>/dev/null \
  | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' 2>/dev/null \
  | head -n 1 \
  | sed -n 's/.*"\([^"]*\)"$/\1/p')
# Only what would break the envelope is rejected — the guard must not NARROW
# a legitimate value, because a dropped source reads as a fresh start and a
# fresh start is the case the deck refuses. A CLI whose word carries a digit,
# a dash or a colon keeps it.
#
# Control characters count as breaking: a raw tab or 0x0B inside a JSON
# string makes serde reject the WHOLE envelope, so letting one through would
# cost the binding rather than the field. `tr -d` is the portable test —
# `case` has no class for them.
case $why in
  *\"*|*\\*) why="" ;;
esac
[ "$(printf '%s' "$why" | tr -d '[:cntrl:]')" = "$why" ] || why=""

# Where the transcript lives is the one thing these CLIs genuinely disagree
# about, so it is the one thing keyed on the agent.
if [ "$agent" = "kimi" ]; then
  # kimi's hook payload carries no transcript path; the session index maps
  # sessionId -> sessionDir, and the wire.jsonl under it is what the KeepDeck
  # usage tailer follows. Best-effort: an index that hasn't recorded this
  # session yet just yields a bare binding (identity still works).
  transcript=""
  index="$HOME/.kimi-code/session_index.jsonl"
  if [ -f "$index" ]; then
    sdir=$(grep -F "\"$sid\"" "$index" | tail -n 1 \
      | sed -n 's/.*"sessionDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    [ -n "$sdir" ] && transcript="$sdir/agents/main/wire.jsonl"
  fi
else
  # The transcript/rollout path rides along when the hook payload carries one —
  # codex usage tailing needs it.
  transcript=$(printf '%s' "$payload" \
    | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)
fi
# Unlike the UUID id, a PATH can carry JSON-hostile characters: a quote or a
# backslash would corrupt the envelope and cost the pane its whole binding —
# better a bare bind than none.
case $transcript in
  *\"*|*\\*) transcript="" ;;
esac

# Assembled field by field rather than one printf per shape: two optional
# fields are already four shapes, and the next one would be eight.
body=$(printf '{"agent":"%s","sessionId":"%s"' "$agent" "$sid")
[ -n "$transcript" ] && body=$(printf '%s,"transcriptPath":"%s"' "$body" "$transcript")
[ -n "$why" ] && body=$(printf '%s,"source":"%s"' "$body" "$why")
[ -n "$reporter" ] && body=$(printf '%s,"reporter":"%s"' "$body" "$reporter")
body="$body}"

send_envelope session.bound "$(printf '{"v":1,"type":"session.bound","paneId":"%s","token":"%s","payload":%s}' \
  "$pane" "$token" "$body")"
exit 0
