import { describe, expect, it } from "vitest";
import { mintAgentSeq, mintWorkspaceSeq } from "./ids";

describe("id mints", () => {
  it("never hands the same agent seq out twice", () => {
    // Pane ids key the PTY input registry and the agent↔worktree records, so a
    // repeat would bind two panes to one process.
    const first = mintAgentSeq();
    expect(mintAgentSeq()).toBe(first + 1);
    expect(mintAgentSeq()).toBe(first + 2);
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

  it("refuses to allocate an imprecise workspace sequence", () => {
    expect(mintWorkspaceSeq([`ws-${Number.MAX_SAFE_INTEGER}`])).toBeNull();
    expect(mintWorkspaceSeq([`ws-${Number.MAX_SAFE_INTEGER - 1}`])).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
