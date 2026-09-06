import { describe, expect, it, vi } from "vitest";
import { provisionTeamsInto } from "./provisioning";

describe("provisionTeamsInto", () => {
  const deck = () => ({
    resolveTeamProvisioning: vi.fn(),
    setTeamProvisioningError: vi.fn(),
    hasTeam: vi.fn(() => true),
  });

  it("routes results into the deck's team provisioning actions for that workspace", () => {
    const sink = deck();
    const cb = provisionTeamsInto(sink, "ws-1");
    cb.onResolved("team-1", { cwd: "/wt/1", branch: "b1" });
    cb.onFailed("team-2", "boom");
    expect(sink.resolveTeamProvisioning).toHaveBeenCalledWith("ws-1", "team-1", {
      cwd: "/wt/1",
      branch: "b1",
    });
    expect(sink.setTeamProvisioningError).toHaveBeenCalledWith("ws-1", "team-2", "boom");
  });

  it("reports a team the deck no longer holds as abandoned", () => {
    const sink = { ...deck(), hasTeam: vi.fn(() => false) };
    expect(provisionTeamsInto(sink, "ws-1").abandoned("team-9")).toBe(true);
    expect(sink.hasTeam).toHaveBeenCalledWith("ws-1", "team-9");
  });

  it("reports a team a confirmed close HOLDS as abandoned, while it is still in the deck", () => {
    // The close is waiting for this very create; what it makes is the
    // close's to remove, so nothing past the directory runs on the team's
    // behalf and nothing resolves its card into a workspace about to lose it.
    const sink = deck();
    const closing = vi.fn((teamId: string) => teamId === "team-1");
    const cb = provisionTeamsInto(sink, "ws-1", closing);
    expect(cb.abandoned("team-1")).toBe(true);
    expect(cb.abandoned("team-2")).toBe(false);
  });
});
