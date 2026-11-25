import { describe, expect, it } from "vitest";
import { unconnectedLaunchView } from "./unconnectedLaunchView";

describe("unconnectedLaunchView", () => {
  it("names the state by what a person loses, and the cause in the failure's own words", () => {
    expect(unconnectedLaunchView({ cause: "plan-failed", error: "settings are not writable" })).toEqual({
      label: "Not connected to KeepDeck",
      sentence: "not connected to KeepDeck",
      reason: "KeepDeck could not set this agent up: settings are not writable. Status, mail and resume won't work until the agent restarts.",
    });
  });

  it("names the plugin and the program it was refused", () => {
    expect(
      unconnectedLaunchView({ cause: "command-refused", pluginId: "acme.agent", command: "curl" }).reason,
    ).toBe(
      'KeepDeck could not set this agent up: acme.agent asked to run "curl", which it is not allowed to run. Status, mail and resume won\'t work until the agent restarts.',
    );
  });

  // Set up and unheard: its tools still work, so it is not "not connected" —
  // and the remedy is the deck's restart or the agent's, by the cause.
  it("says an agent the deck cannot hear is unheard, and what brings it back", () => {
    const down = unconnectedLaunchView({ cause: "bridge-down" });
    expect(down.label).toBe("KeepDeck can't hear this agent");
    expect(down.reason).toMatch(/until KeepDeck restarts\.$/);
    const folder = unconnectedLaunchView({ cause: "pane-dir-failed", error: "no space left on device" });
    expect(folder.label).toBe("KeepDeck can't hear this agent");
    expect(folder.reason).toContain("no space left on device");
    expect(folder.reason).toMatch(/until the agent restarts\.$/);
  });
});
