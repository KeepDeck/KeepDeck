import { describe, expect, it, vi } from "vitest";
import { provisionInto } from "./provisioning";

describe("provisionInto", () => {
  it("routes results into the deck's provisioning actions for that workspace", () => {
    const deck = {
      resolvePaneProvisioning: vi.fn(),
      setPaneProvisioningError: vi.fn(),
      hasPane: vi.fn(() => true),
    };
    const cb = provisionInto(deck, "ws-1");
    cb.onResolved("pane-1", { cwd: "/wt/1", branch: "b1" });
    cb.onFailed("pane-2", "boom");
    expect(deck.resolvePaneProvisioning).toHaveBeenCalledWith("ws-1", "pane-1", {
      cwd: "/wt/1",
      branch: "b1",
    });
    expect(deck.setPaneProvisioningError).toHaveBeenCalledWith(
      "ws-1",
      "pane-2",
      "boom",
    );
  });

  it("reports a pane the deck no longer holds as abandoned", () => {
    // The create asks this after every await that could outlive its pane, so a
    // sink that merely no-ops is not enough — it has to answer.
    const deck = {
      resolvePaneProvisioning: vi.fn(),
      setPaneProvisioningError: vi.fn(),
      hasPane: vi.fn(() => false),
    };
    expect(provisionInto(deck, "ws-1").abandoned("pane-9")).toBe(true);
    expect(deck.hasPane).toHaveBeenCalledWith("ws-1", "pane-9");
  });
});
