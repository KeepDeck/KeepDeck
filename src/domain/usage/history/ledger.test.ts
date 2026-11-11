import { describe, expect, it } from "vitest";
import { usageEvent } from "./event.testSupport";
import { usageAgents } from "./ledger";

describe("usageAgents", () => {
  it("is every agent the ledger has seen, once each, sorted — however long ago", () => {
    expect(
      usageAgents([
        usageEvent({ agent: "zeta", occurredAt: 1 }),
        usageEvent({ agent: "codex" }),
        usageEvent({ agent: "codex" }),
      ]),
    ).toEqual(["codex", "zeta"]);
    expect(usageAgents([])).toEqual([]);
  });
});
