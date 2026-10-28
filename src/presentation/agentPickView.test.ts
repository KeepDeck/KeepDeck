import { describe, expect, it } from "vitest";
import { NO_AGENT_MESSAGE } from "../domain/deck";
import { agentPickView } from "./agentPickView";

describe("agentPickView", () => {
  it("shows the list with the picked agent while there is one to pick, loading or not", () => {
    expect(agentPickView(1, false, "claude")).toEqual({ kind: "pick", value: "claude" });
    expect(agentPickView(3, true, "codex")).toEqual({ kind: "pick", value: "codex" });
  });

  it("shows nothing — not an empty status line — between the catalog arriving and a pick", () => {
    expect(agentPickView(2, false, null)).toEqual({ kind: "settling" });
  });

  it("asks to wait while the catalog is still loading", () => {
    expect(agentPickView(0, true, null)).toEqual({ kind: "notice", text: "Looking for installed agents…" });
  });

  it("names the way out once the catalog loaded empty, whatever was picked before", () => {
    expect(agentPickView(0, false, "claude")).toEqual({ kind: "notice", text: NO_AGENT_MESSAGE });
  });
});
