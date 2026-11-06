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
});
