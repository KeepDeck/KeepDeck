import { describe, expect, it, vi } from "vitest";
import type { Pane } from "../domain/deck";
import { createStatsSessions } from "./statsSessions";

const live: Pane = { id: "p1", agentType: "claude", session: { id: "s-1", boundAt: "t" } };
const workspaces = [{ id: "ws-1", panes: [] as Pane[] }, { id: "ws-2", panes: [live] }];

function door() {
  const calls: string[] = [];
  const sessions = createStatsSessions({
    workspaces: () => workspaces,
    blocked: () => false,
    closeStats: vi.fn(() => calls.push("close")),
    activatePane: vi.fn((wsId: string, paneId: string) => calls.push(`activate ${wsId}/${paneId}`)),
  });
  return { sessions, calls };
}

describe("Statistics' door to a session's pane", () => {
  it("knows a session a pane holds, by agent and id", () => {
    const { sessions } = door();
    expect(sessions.held({ agent: "claude", sessionId: "s-1" })).toBe(true);
    expect(sessions.held({ agent: "codex", sessionId: "s-1" })).toBe(false);
  });

  it("closes the dialog first, then brings the pane in front in its workspace", () => {
    const { sessions, calls } = door();
    sessions.reveal({ agent: "claude", sessionId: "s-1" });
    expect(calls).toEqual(["close", "activate ws-2/p1"]);
  });

  it("opens nothing for a session no pane holds any longer", () => {
    const { sessions, calls } = door();
    sessions.reveal({ agent: "claude", sessionId: "gone" });
    expect(calls).toEqual([]);
  });
});
