import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import { reduceStatus, type PaneActivity, type PaneStatus } from "./activity";

/**
 * The `context-compacted` edge — the only escape from `failed` other than a
 * new turn.
 *
 * Driven through `reduceStatus` rather than a helper that unwraps the
 * activity, because two of the rules here are about what the edge must NOT
 * touch: the held ending, and the object identity the tracker uses to skip
 * an emit. Both are invisible to a helper that returns the activity alone.
 */
const status = (activity: PaneActivity | null): PaneStatus | null =>
  activity && { activity, openAgentTurns: new Set(), heldEnd: null };

const compacted = (at: number): AgentStatusEvent => ({
  kind: "context-compacted",
  at,
});

const fold = (...events: AgentStatusEvent[]): PaneStatus | null =>
  events.reduce<PaneStatus | null>(
    (state, event) => reduceStatus(state, event),
    null,
  );

describe("a context rebuild", () => {
  it("clears a recorded failure, and the next prompt runs normally", () => {
    // The bug this edge exists for: a pane records a failure, the user
    // compacts, and nothing in the status lane could ever un-redden it — a
    // manual compaction runs through no turn, so neither a start nor an
    // ending follows it. The error is deliberately NOT an oversize request:
    // that one no longer reaches the domain at all (the claude plugin reads
    // it as the turn continuing), which leaves this edge as the backstop
    // for the failures a vendor lane could not identify.
    const failed = status({
      state: "failed",
      at: 100,
      error: "unknown",
      detail: "400 the payload never arrived whole",
    });

    const settled = reduceStatus(failed, compacted(200));
    expect(settled?.activity).toEqual({
      state: "done",
      at: 200,
      interrupted: true,
    });

    expect(
      reduceStatus(settled, { kind: "turn-start", at: 300 })?.activity,
    ).toEqual({ state: "working", since: 300 });
  });

  it("leaves a running turn exactly as it was", () => {
    // claude's AUTOMATIC compaction runs inside a turn, between that turn's
    // `UserPromptSubmit` and its `Stop` (probe-verified on 2.1.222). It
    // proves nothing about the turn, so it must not restart the phase — the
    // header's age would jump — nor cost an emit.
    const working = status({ state: "working", since: 100 });
    expect(reduceStatus(working, compacted(200))).toBe(working);
  });

  it("does not answer a standing wait", () => {
    // A rebuild is not the user's answer. Clearing the wait here would
    // end the phase while the question behind it still stands — the pane
    // would read "working" with nobody working on it.
    const waiting = status({
      state: "waiting",
      since: 100,
      reason: "permission",
    });
    expect(reduceStatus(waiting, compacted(200))).toBe(waiting);
  });

  it("does not re-finish a completed turn", () => {
    // "Done" must not become "Interrupted" because the user tidied their
    // context afterwards — the turn really did complete.
    const done = status({ state: "done", at: 100, interrupted: false });
    expect(reduceStatus(done, compacted(200))).toBe(done);
  });

  it("settles nothing at a pane that has reported nothing", () => {
    // Attaching mid-session. The edge makes no claim about a turn, so there
    // is no state to mint from it — `null` is how the tracker spells "not
    // tracked", and a card for a pane the deck never heard from is noise.
    expect(reduceStatus(null, compacted(200))).toBeNull();
  });

  it("keeps an ending that an open agent turn is holding back", () => {
    // The main thread closed while a subagent ran, so the ending is held
    // for the last bracket to replay. A rebuild is not a turn boundary and
    // must not drop it — nothing else would ever finish the pane.
    //
    // Driven as the REAL stream: a compaction reports its summarizer's
    // `SubagentStop` first, and that close names an agent this pane never
    // opened a bracket for (measured on 2.1.222: a populated `agent_id`
    // with no matching `SubagentStart`), so it must pass through inert.
    const held = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "turn-end", at: 120 },
      { kind: "agent-turn-end", at: 130, id: "summarizer" },
      compacted(140),
    );
    expect(held?.heldEnd).toBe(120);
    expect(held?.activity).toEqual({ state: "working", since: 100 });
    expect(held?.openAgentTurns).toEqual(new Set(["a"]));

    expect(
      reduceStatus(held, { kind: "agent-turn-end", at: 200, id: "a" })
        ?.activity,
    ).toEqual({ state: "done", at: 200, interrupted: false });
  });

  it("absorbs a second rebuild instead of restamping the first", () => {
    // Compactions repeat — a long session compacts many times — and the
    // pane is no longer failed after the first. The second must come back
    // as the SAME object: a fresh one costs a re-render and would drag the
    // card's age forward to an instant nothing happened at.
    const failed = status({ state: "failed", at: 100, error: "rate_limit" });
    const settled = reduceStatus(failed, compacted(200));
    expect(reduceStatus(settled, compacted(300))).toBe(settled);
  });
});
