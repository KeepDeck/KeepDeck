import {
  isJsonRecord,
  statusSourceInstant,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/**
 * codex's turn-lifecycle payloads → status edges. The reporter wraps each
 * hook payload verbatim under `event`; fields live-verified on 0.145/0.146.
 *
 * codex's surface is the narrowest of the four: `PermissionRequest` is its
 * only waiting edge, and it has NO failure event — an API-error turn is
 * invisible to hooks (a known gap; only the rollout could tell). A user
 * interrupt pushes no hook either — that edge arrives from the host's
 * rollout tailer as `kind: "session.interrupt"` (marker = a record of TYPE
 * `turn_aborted`, so assistant text can't trip it), stamped with the
 * marker's own time. EVERY abort reason maps to `interrupted`, not just
 * the user's Esc: an aborted turn did not complete, and `turn-end` would
 * announce "finished" for a turn that was cut — the smaller lie is a
 * quiet "Interrupted" (whose announce is suppressed by design). In the
 * common non-Esc case ("replaced") a new turn's own edge follows at once
 * and settles the display anyway.
 *
 * ALL FOUR armed events exist and fire — measured on 0.146, and stated by
 * codex's own `HookEventsToml`, which carries eleven names including the two
 * an audit once reported missing. Do not "fix" a stuck badge by dropping
 * `UserPromptSubmit`/`Stop` for rollout-sourced bookends: they are the only
 * bookends codex has, and the tailer would replace working edges with
 * polled ones.
 *
 * The real gap is that codex never reports an approval ANSWER. Measured
 * sequence for one escalated command:
 *
 *   UserPromptSubmit · PreToolUse · PostToolUse (the sandbox refused)
 *   PreToolUse · PermissionRequest        ← the ask
 *      [the user answers — nothing is emitted, and the rollout is silent too]
 *   PostToolUse                           ← the approved command FINISHED
 *   Stop
 *
 * `PreToolUse` fires BEFORE the ask, so arming it would buy no resolution.
 * The host closes this itself: it sees the keystroke that answers, and
 * `agentStatusChannel` folds it as `resumed`. The `PostToolUse` case below
 * therefore remains the backstop for an answer given some other way, not
 * the primary resolution.
 */
export const normalizeCodexStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload)) return null;
  if (payload.kind === "session.interrupt") {
    return { kind: "interrupted", at: statusSourceInstant(payload, at) };
  }
  if (!isJsonRecord(payload.event)) return null;
  switch (payload.event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      return { kind: "turn-end", at };
    case "PermissionRequest":
      return { kind: "waiting", at, reason: "permission" };
    case "PostToolUse":
      // The backstop, not the resolution: an approved tool's completion is
      // the first post-approval hook codex sends, which is as late as the
      // command is long. The host's own read of the user's answer clears
      // the wait when it is given; this still settles a pane whose answer
      // never came through us. Mid-turn repeats are absorbed by the reducer
      // without an emit.
      return { kind: "resumed", at };
    default:
      return null;
  }
};
