import { describe, expect, it } from "vitest";
import type { PaneActivity } from "./activity";
import { paneFrame, workspaceFrame, type PaneFrameFacts } from "./frame";

const working: PaneActivity = { state: "working", since: 1 };
const waiting: PaneActivity = { state: "waiting", since: 1, reason: "permission" };
const done: PaneActivity = { state: "done", at: 1, interrupted: false };
const interrupted: PaneActivity = { state: "done", at: 1, interrupted: true };
const failed: PaneActivity = { state: "failed", at: 1, error: "rate_limit" };

/** The facts of an ordinary gridded pane — the shape every caller fills. */
function grid(
  activity: PaneActivity | undefined,
  selected: boolean,
): PaneFrameFacts {
  return { activity, selected, fullBleed: false };
}

/** The facts of a pane that fills the whole stage (maximized, or the only
 * one there is) — the surface whose rim speaks for attention alone. */
function fullBleed(activity: PaneActivity | undefined): PaneFrameFacts {
  return { activity, selected: false, fullBleed: true };
}

describe("paneFrame", () => {
  it("attention outranks selection — selected is where the cursor is, not the eyes", () => {
    expect(paneFrame(grid(failed, true))).toBe("failed");
    expect(paneFrame(grid(waiting, true))).toBe("waiting");
  });

  it("attention pierces the full-bleed rim — the one thing that rim still says", () => {
    // A full-height approval prompt is exactly as easy to lean past as a
    // gridded one; the rim is the only signal that survives maximizing.
    expect(paneFrame(fullBleed(failed))).toBe("failed");
    expect(paneFrame(fullBleed(waiting))).toBe("waiting");
  });

  it("the full-bleed rim says nothing else — the pane's own header spells working/done out in place", () => {
    expect(paneFrame(fullBleed(working))).toBe("none");
    expect(paneFrame(fullBleed(done))).toBe("none");
    // Selection too: there is nothing to pick out from — the pane IS the
    // whole stage.
    expect(paneFrame({ ...fullBleed(working), selected: true })).toBe("none");
    expect(paneFrame(fullBleed(undefined))).toBe("none");
  });

  it("failed outranks waiting", () => {
    // One pane can't hold both states, but the ladder must still order
    // them: a new caller aggregating panes (rail, tray) relies on it.
    expect(paneFrame(grid(failed, false))).toBe("failed");
  });

  it("done yields to selection", () => {
    expect(paneFrame(grid(done, true))).toBe("selected");
    expect(paneFrame(grid(done, false))).toBe("done");
    // An interrupt ends the turn the same way for the frame.
    expect(paneFrame(grid(interrupted, false))).toBe("done");
  });

  it("working frames, but yields to selection like done does", () => {
    expect(paneFrame(grid(working, false))).toBe("working");
    expect(paneFrame(grid(working, true))).toBe("selected");
  });

  it("every activity state wears its own rung — none can silently fall through", () => {
    // The failure mode the single SEVERITY home exists against: a state
    // ranked in the fold but unhandled at the pane reads as "none".
    for (const activity of [failed, waiting, working, done]) {
      expect(paneFrame(grid(activity, false))).toBe(activity.state);
    }
  });

  it("no activity: selection or nothing", () => {
    expect(paneFrame(grid(undefined, true))).toBe("selected");
    expect(paneFrame(grid(undefined, false))).toBe("none");
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

  it("a live fact outranks a finished turn's tail in the fold", () => {
    expect(workspaceFrame([working], false)).toBe("working");
    expect(workspaceFrame([done, working], false)).toBe("working");
    expect(workspaceFrame([working, waiting, done], false)).toBe("waiting");
  });

  it("working and done mark only a background workspace — the active one is on screen", () => {
    expect(workspaceFrame([done], false)).toBe("done");
    expect(workspaceFrame([working, done], true)).toBe("selected");
    expect(workspaceFrame([working], true)).toBe("selected");
  });

  it("a quiet pane leaves the dot to the active/none default", () => {
    expect(workspaceFrame([undefined], true)).toBe("selected");
    expect(workspaceFrame([undefined], false)).toBe("none");
  });

  it("an empty workspace still answers: active green, background gray", () => {
    expect(workspaceFrame([], true)).toBe("selected");
    expect(workspaceFrame([], false)).toBe("none");
  });
});
