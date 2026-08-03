import {
  isJsonRecord,
  statusSourceInstant,
  turnFailedEvent,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/**
 * Whether a turn-ending payload reports work that OUTLIVES the turn.
 *
 * `Stop` fires when the MAIN thread finishes its reply — a thread that may
 * have launched background agents or shell tasks still running behind it,
 * and that claude will wake again once they finish. `background_tasks` is
 * the discriminator claude ships for exactly this question (its own schema:
 * "distinguish 'session is done' from 'session is paused waiting for
 * background work to wake it'"), and it lists ONLY in-flight work — so its
 * LENGTH is the whole test, and an entry's `status` is claude's business
 * rather than ours (binary-probed on 2.1.220: a background task that
 * finished before `Stop` leaves `[]`, one still running is listed).
 *
 * Anything that is not an array — the field absent on an older build, a
 * shape a newer one invents — reads as "no background work". Ending the
 * turn is the RECOVERABLE mistake: the next prompt opens a new one, while a
 * turn wrongly held open strands the pane on "Working" until the process
 * dies.
 */
function outlivesTurn(event: Record<string, unknown>): boolean {
  const tasks = event.background_tasks;
  return Array.isArray(tasks) && tasks.length > 0;
}

/**
 * Whether this hook fired from INSIDE a subagent rather than on the main
 * thread. claude's own schema names `agent_id` as the discriminator — it is
 * "present only when the hook fires from within a subagent… absent for the
 * main thread, even in `--agent` sessions" — and explicitly warns off
 * `agent_type`, which the main thread also carries in an `--agent` session.
 */
function fromSubagent(event: Record<string, unknown>): boolean {
  return typeof event.agent_id === "string";
}

/**
 * claude's turn-lifecycle payloads → status edges. The reporter wraps each
 * hook payload verbatim under `event`; the fields here are pinned by the
 * shipped binary's own hook schemas (2.1.220):
 *
 * - `UserPromptSubmit` → the turn is running.
 * - `Stop` → the turn completed — or `parked`, when it left background work
 *   behind ([`outlivesTurn`]). Fires INSTEAD of `StopFailure`, never both.
 * - `StopFailure` → the turn died on an API error; `error` is claude's
 *   typed reason (`rate_limit`, `authentication_failed`, …), verified to
 *   ride in the payload — no per-matcher fan-out needed. Background work is
 *   deliberately NOT consulted here: a turn that died needs the user now,
 *   and surviving background tasks do not make it un-failed.
 * - `Notification` → waiting, but only the two types that mean "parked on
 *   the user": `permission_prompt` and `agent_needs_input`. Binary-verified
 *   caveat (2.1.220): these are 6-second IDLE NUDGES, not dialog-open
 *   events — while the user keeps typing they may never fire, and even
 *   idle they run ≥6s late. The waiting edge is therefore best-effort for
 *   claude; `Stop` still settles the turn either way. `idle_prompt` and
 *   the rest are not turn states — dropped.
 * - `PostToolUse` → resumed, but only from the MAIN thread ([`fromSubagent`]).
 *   claude has no approval-REPLY hook, but an approved tool RUNS — its
 *   completion is the first post-approval hook and proves the wait
 *   resolved. For a long-running tool the amber clears only when the tool
 *   finishes (late, but bounded by the tool, not the turn); mid-turn
 *   repeats are absorbed by the reducer without an emit, so per-tool
 *   volume costs nothing downstream.
 *
 * A user interrupt (Esc) pushes NO hook — that edge arrives from the
 * host's transcript tailer as a `kind: "session.interrupt"` payload
 * (marker = the structured `interruptedMessageId` field on the transcript
 * record, so an assistant merely quoting the phrase can't trip it).
 */
export const normalizeClaudeStatus: StatusNormalizer = (
  payload,
  at,
): AgentStatusEvent | null => {
  if (!isJsonRecord(payload)) return null;
  if (payload.kind === "session.interrupt") {
    // The marker's OWN time, not receipt: the tail polls, so receipt runs
    // up to an interval late — stamped honestly, a marker that predates the
    // next turn's start is droppable as stale.
    return { kind: "interrupted", at: statusSourceInstant(payload, at) };
  }
  if (!isJsonRecord(payload.event)) return null;
  const event = payload.event;
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return { kind: "turn-start", at };
    case "Stop":
      // Background work in flight means the turn is PARKED, not over: the
      // wake it triggers arrives as a fresh `UserPromptSubmit`, so the turn
      // re-opens on its own and only the LAST `Stop` (empty list) ends it.
      return outlivesTurn(event)
        ? { kind: "parked", at }
        : { kind: "turn-end", at };
    case "PostToolUse":
      // A subagent's own tool calls reach this hook too, and they prove
      // nothing about the MAIN thread's approval — the wait this edge would
      // resolve. Worse, background agents run concurrently, so agent B's
      // tool call would clear a prompt agent A is still blocked on, and the
      // next nudge would re-raise it: a flapping banner over a question
      // nobody answered. Only the main thread's tools resolve a wait.
      return fromSubagent(event) ? null : { kind: "resumed", at };
    case "StopFailure":
      return turnFailedEvent(at, event.error, event.error_details);
    case "Notification":
      switch (event.notification_type) {
        case "permission_prompt":
          return { kind: "waiting", at, reason: "permission" };
        case "agent_needs_input":
          return { kind: "waiting", at, reason: "question" };
        default:
          return null;
      }
    default:
      return null;
  }
};
