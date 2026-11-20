import { describe, expect, it } from "vitest";
import { intentOutcomeOf } from "./outcome";

describe("intentOutcomeOf", () => {
  it("takes an acceptance with what it made, and a refusal with why", () => {
    const minted = { workspace: null, team: "team-x", panes: ["pane-4"] };
    expect(intentOutcomeOf({ kind: "answered", answer: { kind: "accepted", op: 9, minted } })).toEqual({ kind: "accepted", op: 9, minted });
    expect(intentOutcomeOf({ kind: "answered", answer: { kind: "refused", refusal: { kind: "targetLeaving" } } })).toEqual({
      kind: "refused",
      refusal: { kind: "targetLeaving" },
    });
  });

  it("keeps a silence a silence", () => {
    expect(intentOutcomeOf({ kind: "unavailable" })).toEqual({ kind: "unanswered", reply: { kind: "unavailable" } });
    expect(intentOutcomeOf({ kind: "unknown" })).toEqual({ kind: "unanswered", reply: { kind: "unknown" } });
  });

  it("refuses to read a lease or an admission as an intent's answer", () => {
    expect(() => intentOutcomeOf({ kind: "answered", answer: { kind: "leased", permit: 1 } })).toThrow(/"leased"/);
  });
});
