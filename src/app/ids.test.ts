import { afterEach, describe, expect, it, vi } from "vitest";
import { mintAgentSeq, mintTeamId, mintWorkspaceId } from "./ids";
import { present } from "@keepdeck/plugin-api/testing";

describe("id mints", () => {
  it("never hands the same agent seq out twice", () => {
    // Pane ids key the PTY input registry and the agent↔worktree records, so a
    // repeat would bind two panes to one process.
    const first = mintAgentSeq();
    expect(mintAgentSeq()).toBe(first + 1);
    expect(mintAgentSeq()).toBe(first + 2);
  });

});

describe("mintWorkspaceId", () => {
  afterEach(() => vi.restoreAllMocks());

  it("mints ws- and a random token, a fresh one each time — never a counted ws-N", () => {
    const a = mintWorkspaceId(new Set(["ws-1", "ws-2"]));
    expect(a).toMatch(/^ws-[0-9a-f]{8}$/);
    expect(mintWorkspaceId(new Set(["ws-1", "ws-2"]))).not.toBe(a);
  });

  it("draws again on a clash with an id the deck holds — never hands a taken one out", () => {
    const draws: `${string}-${string}-${string}-${string}-${string}`[] = ["aaaaaaaa-0000-4000-8000-000000000000", "bbbbbbbb-0000-4000-8000-000000000000"];
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => present(draws.shift(), "a generated UUID"));
    expect(mintWorkspaceId(new Set(["ws-aaaaaaaa"]))).toBe("ws-bbbbbbbb");
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
    const draws: `${string}-${string}-${string}-${string}-${string}`[] = ["aaaaaaaa-0000-4000-8000-000000000000", "bbbbbbbb-0000-4000-8000-000000000000"];
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => present(draws.shift(), "a generated UUID"));
    expect(mintTeamId(new Set(["team-aaaaaaaa"]))).toBe("team-bbbbbbbb");
  });
});
