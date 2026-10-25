import { describe, expect, it } from "vitest";
import { isPaneActionTarget } from "./guestContributions";

describe("a pane action's target, as it crosses from the host", () => {
  it("is a workspace ref and a pane id", () => {
    expect(isPaneActionTarget({ workspace: { id: "ws-1", instance: "i-1" }, paneId: "pane-1" })).toBe(true);
  });

  it("is refused when any part of it is missing or of the wrong kind, so the action does not run", () => {
    for (const target of [
      undefined,
      null,
      "pane-1",
      { paneId: "pane-1" },
      { workspace: { id: "ws-1", instance: "i-1" } },
      { workspace: { id: "ws-1" }, paneId: "pane-1" },
      { workspace: "ws-1", paneId: "pane-1" },
      { workspace: { id: "ws-1", instance: "i-1" }, paneId: 7 },
    ]) {
      expect(isPaneActionTarget(target)).toBe(false);
    }
  });
});
