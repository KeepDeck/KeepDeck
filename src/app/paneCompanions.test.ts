import { describe, expect, it } from "vitest";
import { declinedWakeOf } from "./paneCompanions";

// What a companion's hello and decline do once they are admitted — and which
// of them are admitted at all — is held on the host
// (paneCompanions.host.test.ts). What is left here is the one rule with no
// process in it: how a decline's payload is read.
describe("a declined wake, as its companion reports it", () => {
  const reasonOf = (reason: unknown) => declinedWakeOf({ agent: "claude", reporter: "4021", reason, draft: false }).reason;

  it("keeps the agent's reason as one clean short line", () => {
    expect(reasonOf("the session was stopped")).toBe("the session was stopped");
    // The pane's process wrote it: no line breaks or bidi tricks reach the
    // log, and nothing longer than a reason.
    expect(reasonOf("one\nline‮")).toBe("one line");
    expect(reasonOf("x".repeat(500))).toBe("x".repeat(200));
    expect(reasonOf(7)).toBe("no reason given");
    expect(declinedWakeOf("not a report")).toEqual({ reason: "no reason given", draft: true });
  });

  it("takes the composer for empty only when the companion says so in as many words", () => {
    // A typed line sends whatever the composer holds; a report that does not
    // say "empty" plainly must not be the thing that sends a draft.
    expect(declinedWakeOf({ reason: "r", draft: false }).draft).toBe(false);
    for (const draft of [true, undefined, "false", 0, null]) {
      expect(declinedWakeOf({ reason: "r", draft }).draft).toBe(true);
    }
  });
});
