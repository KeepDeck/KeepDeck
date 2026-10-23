import { describe, expect, it } from "vitest";
import { kimiBinding } from "./binding";

describe("kimi's /new", () => {
  it("is a fresh startup from the pane's own process", () => {
    expect(kimiBinding.restartsConversation({ source: "startup", facts: {} })).toBe(true);
  });

  it("is no other word, nor a report with none", () => {
    // resume binds on its own; an unknown or missing word leaves the deck's
    // refusal standing.
    for (const source of ["resume", "subagent", "", undefined]) {
      expect(
        kimiBinding.restartsConversation({ ...(source !== undefined ? { source } : {}), facts: {} }),
      ).toBe(false);
    }
  });
});
