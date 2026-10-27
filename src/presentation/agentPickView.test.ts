import { describe, expect, it } from "vitest";
import { NO_AGENT_MESSAGE } from "../domain/deck";
import { agentPickNotice } from "./agentPickView";

describe("agentPickNotice", () => {
  it("says nothing while there is an agent to pick, loading or not", () => {
    expect(agentPickNotice(1, false)).toBeNull();
    expect(agentPickNotice(3, true)).toBeNull();
  });

  it("asks to wait while the catalog is still loading", () => {
    expect(agentPickNotice(0, true)).toBe("Looking for installed agents…");
  });

  it("names the way out once the catalog loaded empty", () => {
    expect(agentPickNotice(0, false)).toBe(NO_AGENT_MESSAGE);
  });
});
