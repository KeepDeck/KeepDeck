#!/bin/sh
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
# Speaks bridge protocol v2: the spawn's single KEEPDECK_BRIDGE env var
# carries {v, dir, pane, token, url}; the hook payload arrives as JSON on
# stdin. The payload's session_id becomes a `session.bound` envelope posted
# to the deck. SessionStart also fires for resume, /clear and compaction, so
# a mid-life session swap rebinds the pane automatically.
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

# @include lib/reporter-bridge.sh
[ -n "$url" ] && [ -n "$pane" ] && [ -n "$token" ] || exit 0

# @include lib/reporter-identity.sh

# @include lib/reporter-send.sh

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

send_envelope "$(printf '{"v":2,"type":"session.bound","paneId":"%s","token":"%s","payload":%s}' \
  "$pane" "$token" "$body")"
exit 0
