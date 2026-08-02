import { describe, expect, it } from "vitest";
import type { PaneActivity } from "./activity";
import { paneFrame, workspaceFrame } from "./frame";

const working: PaneActivity = { state: "working", since: 1 };
const waiting: PaneActivity = { state: "waiting", since: 1, reason: "permission" };
const done: PaneActivity = { state: "done", at: 1, interrupted: false };
const interrupted: PaneActivity = { state: "done", at: 1, interrupted: true };
const failed: PaneActivity = { state: "failed", at: 1, error: "rate_limit" };

describe("paneFrame", () => {
  it("attention outranks selection — selected is where the cursor is, not the eyes", () => {
    expect(paneFrame(failed, true)).toBe("failed");
    expect(paneFrame(waiting, true)).toBe("waiting");
  });

  it("failed outranks waiting", () => {
    // One pane can't hold both states, but the ladder must still order
    // them: a new caller aggregating panes (rail, tray) relies on it.
    expect(paneFrame(failed, false)).toBe("failed");
  });

  it("done yields to selection", () => {
    expect(paneFrame(done, true)).toBe("selected");
    expect(paneFrame(done, false)).toBe("done");
    // An interrupt ends the turn the same way for the frame.
    expect(paneFrame(interrupted, false)).toBe("done");
  });

  it("working never frames — a quiet deck is the point", () => {
    expect(paneFrame(working, false)).toBe("none");
    expect(paneFrame(working, true)).toBe("selected");
  });

  it("no activity: selection or nothing", () => {
    expect(paneFrame(undefined, true)).toBe("selected");
    expect(paneFrame(undefined, false)).toBe("none");
  });
});

describe("workspaceFrame", () => {
  it("any pane's attention wins for the workspace, failed over waiting", () => {
    expect(workspaceFrame([working, waiting, done], false)).toBe("waiting");
    expect(workspaceFrame([waiting, failed, undefined], false)).toBe("failed");
  });

  it("attention pierces the active workspace's green", () => {
    expect(workspaceFrame([waiting], true)).toBe("waiting");
    expect(workspaceFrame([failed], true)).toBe("failed");
  });

  it("done marks only a background workspace — the active one is on screen", () => {
    expect(workspaceFrame([working, done], false)).toBe("done");
    expect(workspaceFrame([working, done], true)).toBe("selected");
  });

  it("quiet panes leave the dot to the active/none default", () => {
    expect(workspaceFrame([working, undefined], true)).toBe("selected");
    expect(workspaceFrame([working, undefined], false)).toBe("none");
    expect(workspaceFrame([], false)).toBe("none");
  });
});
