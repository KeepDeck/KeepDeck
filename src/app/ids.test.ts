import { afterEach, describe, expect, it, vi } from "vitest";
import { mintAgentSeq, mintTeamId, mintWorkspaceSeq } from "./ids";

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

describe("mintTeamId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("mints team- and a random token, a fresh one each time", () => {
    const a = mintTeamId(new Set());
    expect(a).toMatch(/^team-[0-9a-f]{8}$/);
    expect(mintTeamId(new Set())).not.toBe(a);
  });

  it("draws again on a clash with an id the deck holds — never hands a taken one out", () => {
    const draws = ["aaaaaaaa-0000-4000-8000-000000000000", "bbbbbbbb-0000-4000-8000-000000000000"];
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => draws.shift() as `${string}-${string}-${string}-${string}-${string}`);
    expect(mintTeamId(new Set(["team-aaaaaaaa"]))).toBe("team-bbbbbbbb");
  });
});
