import { describe, expect, it } from "vitest";
import { mintAgentSeq, mintAgentSeqs, mintWorkspaceSeq } from "./ids";

describe("id mints", () => {
  it("a batch reservation hands out exactly `count` seqs before the next mint", () => {
    const start = mintAgentSeqs(3);
    // The next single mint must land right after the reserved block — an
    // off-by-one here would collide pane ids with the batch's panes.
    expect(mintAgentSeq()).toBe(start + 3);
  });

  it("derives the workspace seq from the current maximum", () => {
    expect(mintWorkspaceSeq([])).toBe(1);
    expect(mintWorkspaceSeq(["ws-1", "imported", "ws-3"])).toBe(4);
  });

  it("releases the maximum workspace seq when that workspace disappears", () => {
    expect(mintWorkspaceSeq(["ws-1", "ws-2", "ws-3"])).toBe(4);
    expect(mintWorkspaceSeq(["ws-1", "ws-2"])).toBe(3);
  });

  it("does not fill gaps below the live maximum", () => {
    expect(mintWorkspaceSeq(["ws-1", "ws-3"])).toBe(4);
  });
});
