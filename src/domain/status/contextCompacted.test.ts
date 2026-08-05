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
    // The bug this edge exists for: claude gives up on an oversize request
    // (`StopFailure` → failed), the user compacts, and nothing in the
    // status lane could ever un-redden the pane — a manual compaction runs
    // through no turn, so neither a start nor an ending follows it.
    const failed = status({
      state: "failed",
      at: 100,
      error: "invalid_request",
      detail: "prompt is too long: 1000908 tokens > 1000000 maximum",
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
    // retract a notification the question behind it still deserves.
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
    const held = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "turn-end", at: 120 },
      compacted(130),
    );
    expect(held?.heldEnd).toBe(120);
    expect(held?.activity).toEqual({ state: "working", since: 100 });

    expect(
      reduceStatus(held, { kind: "agent-turn-end", at: 200, id: "a" })
        ?.activity,
    ).toEqual({ state: "done", at: 200, interrupted: false });
  });
});
