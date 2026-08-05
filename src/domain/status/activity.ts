import type { AgentStatusEvent, StatusWaitReason } from "@keepdeck/plugin-api";

/**
 * What a pane's agent is DOING right now — the fold of its turn-lifecycle
 * edges. Deliberately not part of [`PaneBody`]: that one answers "is there
 * a process / what does the body show", this one "what is the live process
 * up to". A rate-limited turn leaves the process alive and the body on
 * `terminal` — conflating the two is the run-vs-stopped mistake again.
 *
 * Runtime-only, like `pane.head`: never serialized. A persisted "working"
 * would resurrect next launch as a claim about a process that no longer
 * exists.
 *
 * Timestamps are unix milliseconds — receipt time for hook edges, the
 * marker's own source time for tail-recovered markers. Staleness is a
 * property of the EDGE STREAM, not of one edge kind, and the guards below
 * come in two flavors, each catching what the other cannot:
 *
 * - The TIME compare (`at < since`) catches only slow-channel edges — a
 *   tail marker trails the hook lane by up to a poll interval and carries
 *   its own honest time. Hook edges are stamped at APPLY time, so their
 *   `at` is monotonic in processing order and the compare is inert for
 *   them; it becomes load-bearing for `waiting` too the moment any lane
 *   mints a wait with a source time.
 * - The STATE absorbs (done/failed stand) catch reordered HOOK envelopes,
 *   which a receipt-stamped time cannot see its own reordering in.
 *
 * Only a fresh `turn-start` wins unconditionally — it is the one edge that
 * says a NEW turn began, so nothing the old one left behind may survive it.
 */
export type PaneActivity =
  /** A turn is running. `since` is when THIS running phase began — a wait
   * that resolves starts a new phase, so the age answers "how long since
   * you could have walked away". */
  | { state: "working"; since: number }
  /** The turn is blocked on the user. */
  | { state: "waiting"; since: number; reason: StatusWaitReason }
  /** The last turn is over. `interrupted` says HOW: completed, or cut by
   * the user — the card reads differently ("Done" vs "Interrupted"). */
  | { state: "done"; at: number; interrupted: boolean }
  /** The last turn died on an API error. `error` is the CLI's typed reason
   * (`rate_limit`, `authentication_failed`, …), `detail` its prose. */
  | { state: "failed"; at: number; error: string; detail?: string };

/**
 * The pane's whole status-lane state: what the agent is DOING, plus the
 * agent turns running alongside the main thread.
 *
 * `openAgentTurns` is bookkeeping, never displayed. It exists because the
 * payload that reports in-flight work cannot answer "is this one busy right
 * now": claude lists a teammate as `running` for as long as the team lives,
 * idle or not. A bracket around each agent's own turn can answer it, and the
 * one question it settles is whether a closing turn is an ENDING.
 *
 * There is no "nothing reported yet" VALUE of this type — that state is the
 * absence of the pane, which the tracker's map already models. Keeping it
 * unrepresentable is what lets the published snapshot be the full roster
 * rather than a filtered view of one.
 */
export interface PaneStatus {
  readonly activity: PaneActivity;
  /** Agent turns open right now, by the CLI's own agent id. */
  readonly openAgentTurns: ReadonlySet<string>;
  /** When the main turn closed while an agent turn was still open, and so
   * did not end. Replayed as the ending once the last one closes: without
   * it the close of the final agent turn settles nothing and the pane keeps
   * reporting "working" with no edge left to finish it. */
  readonly heldEnd: number | null;
}

const NO_TURNS: ReadonlySet<string> = new Set();

/** The edges that describe the pane's own turn. The agent-turn brackets are
 * NOT among them: they carry no claim about what the pane is doing, and
 * folding them as if they did is how a close would mint a phase out of
 * nothing. [`reduceStatus`] routes them to the set instead, and this type
 * is what keeps that routing from being optional. Not exported — the fold
 * that ships is [`reduceStatus`], and publishing "the inner reducer refuses
 * three members of AgentStatusEvent" would invite a second such alias
 * instead of a fix to the union. */
type ActivityEdge = Exclude<
  AgentStatusEvent,
  | { kind: "agent-turn-start" }
  | { kind: "agent-turn-end" }
  | { kind: "agent-turns-cleared" }
>;

/** Whether an edge is one of the bracket kinds — the routing [`ActivityEdge`]
 * makes mandatory, in the one place that performs it. */
function isAgentTurnEdge(
  event: AgentStatusEvent,
): event is Exclude<AgentStatusEvent, ActivityEdge> {
  return (
    event.kind === "agent-turn-start" ||
    event.kind === "agent-turn-end" ||
    event.kind === "agent-turns-cleared"
  );
}

/** Whether an edge claims the turn is OVER. These are the ones a staleness
 * verdict has to gate, because they are the ones with consequences beyond
 * the activity itself. */
function isEnding(event: AgentStatusEvent): boolean {
  return (
    event.kind === "turn-end" ||
    event.kind === "interrupted" ||
    event.kind === "turn-failed"
  );
}

/** A turn-ending edge must not corrupt the state it lands on. Two
 * orderings, one rule: an edge after the turn already ENDED is the old
 * turn's echo (re-labelling a completed turn would be false), and an edge
 * whose own time predates the current phase belongs to the turn BEFORE
 * that phase — the hook lane is near-instant, so a user who ends a turn
 * and re-prompts within a poll interval has a running turn a trailing
 * marker must not end.
 *
 * The predicate exists so `return current` type-checks non-null in the
 * true branch. CAVEAT for the next editor: TypeScript narrows the FALSE
 * branch to `null` — a lie (a fresh working/waiting reaches it too) —
 * so never read `current` after a false result; mint a new object. */
function endedTurnStands(
  current: PaneActivity | null,
  at: number,
): current is PaneActivity {
  if (current?.state === "done" || current?.state === "failed") return true;
  return (
    (current?.state === "working" || current?.state === "waiting") &&
    at < current.since
  );
}

/**
 * Fold one edge into the pane's whole status state — the activity, plus the
 * helper turns open behind it.
 *
 * The one decision this layer owns: **a turn that closes while an agent turn
 * is still open did not end** — it is HELD, and the ending lands when the
 * last one closes. The plugin cannot make that call: its normalizer is pure,
 * it sees one payload at a time, and the payload that ends a turn does not
 * say whether the agents it lists are busy or merely alive. The bracket is a
 * property of the edge STREAM, so it is folded here, the way staleness is.
 *
 * TWO SURFACES ANSWER "IS THIS CLOSE AN ENDING", and they are a disjunction,
 * never a contradiction — whichever says "not yet" wins. The plugin's
 * `SELF_WAKING` reads the CLI's own list of in-flight work and covers the
 * kinds that have no bracket (a workflow, an MCP monitor, and a subagent
 * that is queued but has not started); this covers the kinds the list cannot
 * judge, teammates above all. Their DEFAULTS differ on purpose and each is
 * argued at its own site: an unknown task kind ends the turn, an unclosed
 * bracket holds it. Change one and read the other — see `SELF_WAKING` in
 * plugins/claude/src/status.ts.
 *
 * `turn-start` deliberately does NOT release the brackets: a background agent
 * outlives the turn that spawned it, which is the whole reason this exists.
 * `interrupted` and `turn-failed` DO — see [`reduceOpenTurns`].
 */
export function reduceStatus(
  current: PaneStatus | null,
  event: AgentStatusEvent,
): PaneStatus | null {
  if (isAgentTurnEdge(event)) {
    const open = reduceOpenTurns(current?.openAgentTurns ?? NO_TURNS, event);
    if (current === null) {
      // Nothing reported for this pane yet — attaching mid-session, or the
      // first edge after a clear. An agent STARTING is honest evidence that
      // the session is working; one ending is evidence of nothing, and a
      // pane that has told us nothing is not thereby done.
      if (open.size === 0) return null;
      return {
        activity: { state: "working", since: event.at },
        openAgentTurns: open,
        heldEnd: null,
      };
    }
    if (open === current.openAgentTurns) return current;
    if (open.size > 0 || current.heldEnd === null) {
      return { ...current, openAgentTurns: open };
    }
    // The last one closed, and the main turn had already closed behind it.
    // Replay that ending NOW rather than at its original instant: the turn
    // is over when the last thing running stopped, which is also the moment
    // the user can act on. Nothing else is coming to settle it.
    return {
      activity: reduceActivity(current.activity, {
        kind: "turn-end",
        at: event.at,
      }),
      openAgentTurns: open,
      heldEnd: null,
    };
  }

  // An ending the activity fold would ABSORB did not happen, so it changes
  // NOTHING — not the brackets, not the held ending. This has to be asked
  // before any of them is computed, because the two failures it prevents
  // both come from a side effect outliving the edge that caused it:
  //
  // - A stale `interrupted` (the tailer stamps markers with their own time,
  //   so one can arrive after a new turn began) would release every bracket
  //   and drop the held ending while leaving the turn running — and nothing
  //   would be left that could ever finish the pane.
  // - A stale `turn-end` would arm a held ending for a turn that had already
  //   closed, which the next bracket close then replays as a fresh "done"
  //   over a turn still in flight.
  //
  // Absorbing is the fold's own verdict, so it is asked with the fold's own
  // predicate rather than a second copy of the rule.
  if (
    current !== null &&
    isEnding(event) &&
    endedTurnStands(current.activity, event.at)
  ) {
    return current;
  }

  // A context rebuild settles ONE thing — that a recorded failure is stale
  // — so at a pane that has reported nothing it settles nothing. Minting a
  // status here would card a pane the deck has never heard from, on an edge
  // that makes no claim about a turn. Asked before the fold, which cannot
  // return "no status at all".
  if (event.kind === "context-compacted" && current === null) return null;

  const open = reduceOpenTurns(current?.openAgentTurns ?? NO_TURNS, event);
  const holds = event.kind === "turn-end" && open.size > 0;
  const settled: ActivityEdge = holds ? { kind: "parked", at: event.at } : event;
  const activity = reduceActivity(current?.activity ?? null, settled);
  const heldEnd = reduceHeldEnd(current?.heldEnd ?? null, event, holds);
  if (
    current !== null &&
    activity === current.activity &&
    open === current.openAgentTurns &&
    heldEnd === current.heldEnd
  ) {
    return current;
  }
  return { activity, openAgentTurns: open, heldEnd };
}

/** The open-bracket set. Returns the SAME set when nothing moved, so an
 * edge that changes nothing survives as an identity all the way out. */
function reduceOpenTurns(
  open: ReadonlySet<string>,
  event: AgentStatusEvent,
): ReadonlySet<string> {
  switch (event.kind) {
    case "agent-turn-start":
      if (open.has(event.id)) return open;
      return new Set(open).add(event.id);
    case "agent-turn-end": {
      if (!open.has(event.id)) return open;
      const next = new Set(open);
      next.delete(event.id);
      return next;
    }
    case "agent-turns-cleared":
    // The turn died. Whatever was running under it is no longer evidence
    // about THIS pane's next turn, and a bracket kept past the death of the
    // thing that opened it can only strand the pane on "working" — there is
    // no edge left that would ever close it. Both edges already end the turn
    // regardless of background work (the user is needed NOW), so releasing
    // the brackets with them changes nothing visible and removes the only
    // unrecoverable failure this set can produce.
    case "interrupted":
    case "turn-failed":
      return open.size === 0 ? open : NO_TURNS;
    default:
      return open;
  }
}

/** The ending an open agent turn is holding back. Set when a `turn-end`
 * lands on open brackets; SURVIVES the edges that neither start nor end a
 * turn, because a wait raised or resolved by the work still running does
 * not un-close the main thread; dropped by anything that starts a new turn
 * or ends this one for real. */
function reduceHeldEnd(
  held: number | null,
  event: ActivityEdge,
  holds: boolean,
): number | null {
  if (holds) return event.at;
  switch (event.kind) {
    case "waiting":
    case "resumed":
    case "parked":
    // A context rebuild is not a turn boundary either: the main thread
    // closed before it and the agents that held that ending open are
    // untouched by it. Dropping the ending here would leave the last
    // bracket's close with nothing to replay, stranding the pane.
    case "context-compacted":
      return held;
    default:
      return null;
  }
}

/**
 * Whether the USER's own answer may be folded into this activity at all.
 *
 * This decides ONE thing the fold below cannot: an answer must not start a
 * phase out of nothing. A `resumed` from an agent's report legitimately does
 * — a tool completed, so something IS running — but at a pane nobody has
 * reported on, a keystroke is just someone typing at a shell, and minting
 * "Working" there would advertise a turn that is not happening.
 *
 * WHICH activities a resume actually moves stays the fold's own call, so
 * that rule keeps its single home: a wait becomes working, and a running or
 * finished turn absorbs the edge unchanged. Re-stating any of that here
 * would be a second copy to keep in step.
 */
export function answerResolves(activity: PaneActivity | null): boolean {
  return activity !== null;
}

/**
 * Fold one edge into the pane's activity — the INNER fold, private to this
 * module: [`reduceStatus`] is the entry point, and reaching past it silently
 * ignores the agent-turn brackets. Pure; ordering discipline for
 * IDENTITY (stale tokens, dead panes, replays) belongs to the tracker
 * feeding this — but ordering discipline for TIME lives here, because
 * edges arrive on two channels (near-instant hooks, a polling tailer) and
 * even one channel can reorder within a tick. Returning `current`
 * UNCHANGED is load-bearing: the tracker drops identical results without
 * an emit, so an absorbed edge never re-renders or re-announces.
 */
function reduceActivity(
  current: PaneActivity | null,
  event: ActivityEdge,
): PaneActivity {
  switch (event.kind) {
    case "turn-start":
      // A new turn trumps whatever the old one left behind. NOT only the
      // user's own prompt: a CLI also injects a turn of its own accord —
      // finished background work waking the session, a scheduled fire — and
      // that is a new turn too, so the phase restarts with it. (claude
      // stamps the difference in `UserPromptSubmit.source`, but the field is
      // vendor-internal and absent from the payloads we receive.)
      return { state: "working", since: event.at };
    case "waiting":
      // A wait can only park a RUNNING turn. After done/failed the edge is
      // an echo (claude's idle nudge fires up to seconds late and can
      // trail the Stop that already ended the turn) — a wait it reports
      // has nothing left to resolve it.
      if (current?.state === "done" || current?.state === "failed") {
        return current;
      }
      // The slow-channel time guard, inert for hook waits (receipt-stamped)
      // but armed the day a tail-recovered wait exists — same rule as the
      // ending edges: an edge older than the phase belongs to before it.
      if (
        (current?.state === "working" || current?.state === "waiting") &&
        event.at < current.since
      ) {
        return current;
      }
      // A re-asserted wait is the SAME question: keep the phase start (the
      // tooltip's age must not reset on every nudge) and the identity (no
      // re-announce). A different reason is a new question — fresh phase.
      if (current?.state === "waiting" && current.reason === event.reason) {
        return current;
      }
      return { state: "waiting", since: event.at, reason: event.reason };
    case "resumed":
      // A resolution resolves a WAIT. Mid-turn it is a no-op (a tool
      // completing while working proves nothing new), and after done or
      // failed it is the answered prompt's echo — resurrecting a turn the
      // CLI already closed would advertise a run that isn't happening.
      if (current?.state === "waiting" || current === null) {
        return { state: "working", since: event.at };
      }
      return current;
    case "parked":
      // The turn did not end, so nothing about the CURRENT phase changes:
      // a running turn keeps running (and keeps its age — the work never
      // stopped), and a standing wait STANDS, because the thing still
      // running is exactly what may be asking. Parking resolves nothing.
      //
      // KNOWN IMPRECISION, deliberately kept. While the main thread idles
      // behind background work, claude's nudge can re-raise a wait and any
      // agent's tool completion can clear it, so an approval prompt may
      // flicker for the length of the run. Recording the parked stretch and
      // suppressing waits inside it was tried and is WORSE: a
      // `permission_prompt` means claude has a dialog UP that the user CAN
      // answer, and silence there strands the very work the parking
      // protects — with nothing left to end the window. A flicker is
      // recoverable; silence is not. A real fix needs the wait to name its
      // raiser, which needs data claude does not give us.
      //
      // After done/failed it is an echo of a turn already closed, absorbed
      // like every other late edge. The one thing it settles is a pane with
      // no activity yet — attaching mid-session, or the first edge after a
      // clear — where in-flight work is honestly "working".
      return current ?? { state: "working", since: event.at };
    case "turn-end":
      if (endedTurnStands(current, event.at)) return current;
      return { state: "done", at: event.at, interrupted: false };
    case "interrupted":
      if (endedTurnStands(current, event.at)) return current;
      return { state: "done", at: event.at, interrupted: true };
    case "turn-failed":
      if (endedTurnStands(current, event.at)) return current;
      return {
        state: "failed",
        at: event.at,
        error: event.error,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
      };
    case "context-compacted": {
      // The ONLY escape from `failed` other than a new turn, and the reason
      // this edge exists: the CLI rebuilt the context that the failure was
      // about, so the error is history and the pane rests idle until the
      // next prompt. `interrupted` because the turn ended without
      // completing — which is what happened — and the tone is the neutral
      // one, so the pane stops shouting about something already dealt with.
      //
      // Every other state is left EXACTLY as it was. A compaction inside a
      // live turn (claude's automatic one runs between the turn's start and
      // its `Stop`) proves nothing about that turn, a standing wait is not
      // answered by one, and a finished turn is not re-finished. `null` is
      // dropped upstream in [`reduceStatus`] and cannot reach here.
      return current === null || current.state === "failed"
        ? { state: "done", at: event.at, interrupted: true }
        : current;
    }
  }
}
