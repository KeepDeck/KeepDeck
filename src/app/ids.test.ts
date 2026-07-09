import { describe, expect, it } from "vitest";
import { mintAgentSeq, mintAgentSeqs, mintWorkspaceSeq } from "./ids";

describe("id mints", () => {
  it("a batch reservation hands out exactly `count` seqs before the next mint", () => {
    const start = mintAgentSeqs(3);
    // The next single mint must land right after the reserved block — an
    // off-by-one here would collide pane ids with the batch's panes.
    expect(mintAgentSeq()).toBe(start + 3);
  });

  it("workspace seqs are independent of agent seqs", () => {
    const ws = mintWorkspaceSeq();
    mintAgentSeqs(5);
    expect(mintWorkspaceSeq()).toBe(ws + 1);
  });
});
