import {
  isJsonRecord,
  statusSourceInstant,
  turnFailedEvent,
  type AgentStatusEvent,
  type StatusNormalizer,
} from "@keepdeck/plugin-api";

/**
 * The background-task kinds that WAKE the session when they finish, and so
 * hold the turn open.
 *
 * An ALLOWLIST, deliberately. claude's published schema names four kinds
 * (`shell`, `subagent`, `monitor`, `workflow`), but the mapper it actually
 * ships emits ten (decompiled from 2.1.220) — and most of the six it leaves
 * undocumented are not work this pane is waiting on:
 *
 *     local_agent → subagent          local_workflow → workflow
 *     monitor_mcp → monitor           monitor_ws     → monitor
 *     mcp_task    → "MCP task"        local_bash     → shell
 *     in_process_teammate → teammate  remote_agent   → "cloud session"
 *     dream       → dream             auto_mode_scan → "auto-mode scan"
 *
 * What each exclusion costs, and why it is still right:
 *
 * - `shell` is one the USER parked deliberately — a dev server, a watcher,
 *   a tail. It may never finish, and nothing wakes the session when it does:
 *   the agent polls it with `BashOutput` inside a turn. One `npm run dev`
 *   would otherwise make EVERY later turn park.
 * - `teammate` is worse, because an IDLE teammate looks identical to a busy
 *   one here: it keeps `status: "running"`, its idleness lives in an
 *   `isIdle` flag the payload does not carry, and the entry survives until
 *   the teammate is killed (claude only evicts TERMINAL tasks). Parking on
 *   it would hold every later turn open for the life of the team — the pane
 *   would never say "done" again. Teammate liveness needs a signal that
 *   brackets a teammate's TURN, not a list that outlives it.
 * - `cloud session` is a detached `--bg` run managed by `claude agents`; it
 *   does not wake this session (claude's own wording: "Detached — N tasks
 *   still running").
 * - `dream` and `auto-mode scan` are ambient housekeeping, not the turn.
 * - a bare `monitor` is a WebSocket monitor, which may watch a stream that
 *   never fires — see [`wakes`] for how it is told apart from the MCP one.
 *
 * This agrees with claude's OWN idle heuristic, which drops teammates,
 * `local_bash`, `dream` and ambient `monitor_ws` from "running background
 * tasks" and counts teammates on a separate axis.
 *
 * An unknown KIND therefore does NOT hold the turn open. That inverts the
 * earlier bet, and the table above is why: of six kinds we had never seen,
 * exactly one was work that wakes the session. An unknown ENTRY SHAPE ends
 * the turn for the same reason a bad list does — ending is the recoverable
 * mistake ([`outlivesTurn`]).
 *
 * The OTHER half of this decision lives in the host's status fold, which
 * holds a turn open while an agent-turn bracket is unclosed. The two are a
 * disjunction over different kinds — this list covers what has no bracket
 * (a workflow, an MCP monitor, a subagent still queued), the fold covers
 * what the list cannot judge (teammates) — and their defaults differ on
 * purpose. Read `reduceStatus` in src/domain/status/activity.ts before
 * changing either.
 */
const SELF_WAKING = new Set(["subagent", "workflow", "monitor", "MCP task"]);

/**
 * Whether ONE in-flight entry will wake the session when it finishes.
 *
 * `monitor` needs more than its name. The wire collapses claude's two
 * monitor kinds into that one string, and for this question they are
 * opposites: an MCP monitor is a tool call that will return, while a
 * WebSocket monitor can watch a stream that never fires — and parking on
 * one that never fires is the unrecoverable failure the whole allowlist
 * exists to avoid. They ARE separable: the mapper attaches `server`/`tool`
 * to the MCP kind and nothing at all to the WebSocket kind (decompiled from
 * 2.1.220), so a monitor that names its server is the one worth waiting for.
 */
function wakes(task: Record<string, unknown>): boolean {
  if (typeof task.type !== "string" || !SELF_WAKING.has(task.type)) {
    return false;
  }
  return task.type !== "monitor" || typeof task.server === "string";
}

/**
 * Whether a turn-ending payload reports work that OUTLIVES the turn.
 *
 * `Stop` fires when the MAIN thread finishes its reply — a thread that may
 * have launched background agents still running behind it, and that claude
 * will wake again once they finish. `background_tasks` is the discriminator
 * claude ships for exactly this question (its own schema: "distinguish
 * 'session is done' from 'session is paused waiting for background work to
 * wake it'"), and it lists ONLY in-flight work — so an entry's `status` is
 * claude's business rather than ours (binary-probed on 2.1.220: a task that
 * finished before `Stop` leaves `[]`, one still running is listed).
 *
 * Its TYPE, though, is ours to read: not everything in flight will wake the
 * session — see [`SELF_WAKING`].
 *
 * Anything that is not an array — the field absent on an older build, a
 * shape a newer one invents — reads as "no background work". So does a
 * payload too big to forward whole, which arrives as its event name alone.
 * Ending the turn is the RECOVERABLE mistake in every one of those cases:
 * the next prompt opens a new turn, while a turn wrongly held open strands
 * the pane on "Working" until the process dies.
 */
function outlivesTurn(event: Record<string, unknown>): boolean {
  const tasks = event.background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((task) => isJsonRecord(task) && wakes(task));
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
 * - `SubagentStart`/`SubagentStop` → the open/close bracket of ONE agent
 *   turn running beside the main thread. Both a background subagent and a
 *   teammate raise them, and the pair carries the same `agent_id`.
 * - `PostToolUse`/`PostToolUseFailure` → resumed. claude has no approval-REPLY hook, but an
 *   approved tool RUNS — its completion is the first post-approval hook
 *   and proves the wait resolved. For a long-running tool the amber
 *   clears only when the tool finishes (late, but bounded by the tool,
 *   not the turn); mid-turn repeats are absorbed by the reducer without
 *   an emit, so per-tool volume costs nothing downstream. Subagent tool
 *   calls arrive here too — see the case for why they are NOT filtered.
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
    case "SubagentStart":
      // One agent loop serves both kinds of side work: a background subagent
      // and a teammate run through the same entry, which fires this on the
      // way in and `SubagentStop` on the way out, carrying the same
      // `agent_id` (probe-verified for subagents on 2.1.220; the teammate
      // path is the same function, decompiled). The bracket is what tells a
      // busy teammate from an idle one, which the task list cannot: it
      // reports both as `running` — see [`SELF_WAKING`]. claude does ship a
      // `TeammateIdle` hook, but it announces only the IDLE half and has no
      // counterpart for a teammate going busy, so it cannot bracket a turn
      // on its own.
      //
      // No id, no bracket: one that cannot be paired would never close, and
      // an open bracket holds the turn open. Dropping it risks ending a turn
      // early instead, which the next wake repairs.
      return typeof event.agent_id === "string" && event.agent_id
        ? { kind: "agent-turn-start", at, id: event.agent_id }
        : null;
    case "SubagentStop":
      // The id goes missing when the payload was too big to forward whole
      // (`last_assistant_message` rides on this one, so it is the newly
      // armed event that can realistically exceed the cap). The close still
      // has to land, and an end that cannot name what it closed is a
      // different fact with its own edge — one that discards every bracket
      // rather than silently taking the rest down with it under the guise
      // of a normal close.
      return typeof event.agent_id === "string" && event.agent_id
        ? { kind: "agent-turn-end", at, id: event.agent_id }
        : { kind: "agent-turns-cleared", at };
    case "PostToolUse":
    // A tool that was approved and then FAILED resolves the wait just as
    // one that succeeded does — claude routes those to a separate event,
    // and arming only the happy path left an answered approval amber until
    // the turn ended.
    case "PostToolUseFailure":
      // KNOWN IMPRECISION, deliberately kept. A subagent's own tool calls
      // reach this hook too (they carry `agent_id`), so with several agents
      // in flight one agent's completion can clear a wait another raised.
      // Gating on `agent_id` was tried and is WORSE: a wait is not tagged
      // with who raised it — claude's `Notification` carries no agent id —
      // so dropping subagent edges also drops the one that genuinely
      // resolved the wait, and a synchronous Task blocks the main thread
      // from sending any, leaving an answered approval amber for the whole
      // subagent run. Clearing early self-corrects (the next idle nudge
      // re-raises it); a stuck amber does not. Recoverable wins, the same
      // rule [`outlivesTurn`] follows. A real fix needs the wait to carry
      // its raiser, which needs data claude does not yet give us.
      return { kind: "resumed", at };
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
