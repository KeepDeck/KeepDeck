import { describe, expect, it } from "vitest";
import type { PaneActivity } from "../domain/status";
import { teamSuspendConfirmView } from "./teamSuspendView";

const working: PaneActivity = { state: "working", since: 1 };
const waiting: PaneActivity = { state: "waiting", since: 2, reason: "permission" };
const done: PaneActivity = { state: "done", at: 3, interrupted: false };
const team = { name: "team management" };
const KEEPS =
  "its pane, its place on the team, the board and the worktree. Resume requests a start again; when its conversation is recorded, its agent is asked to reopen it where it can.";

const view = (size: number, shown: string[], live: Record<string, PaneActivity> = {}) =>
  teamSuspendConfirmView(team, size, shown, new Map(Object.entries(live)));

describe("teamSuspendConfirmView — asked every time, whatever the agents are doing", () => {
  it("says whose work is at risk, then what each keeps — Cancel beside one Suspend for them all", () => {
    expect(view(4, ["a", "b", "c", "d"], { a: working, b: waiting, c: done })).toEqual({
      title: "Suspend “team management”?",
      message: `This requests a stop for all 4 agents. 1 is in the middle of a turn and 1 is waiting for your answer — that work or that prompt may be lost.\n\nEach keeps ${KEEPS}`,
      confirmLabel: "Suspend all 4",
      cancelLabel: "Cancel",
      shown: ["a", "b", "c", "d"],
    });
  });

  it("asks even when nobody is mid-turn, without a risk it cannot name", () => {
    expect(view(2, ["a", "b"], { a: done })?.message).toBe(`This requests a stop for all 2 agents.\n\nEach keeps ${KEEPS}`);
  });

  it("agrees each side of the risk with its own count", () => {
    expect(view(3, ["a", "b", "c"], { a: working, b: working })?.message).toContain(
      "all 3 agents. 2 are in the middle of a turn — that work may be lost.",
    );
    expect(view(3, ["a", "b", "c"], { b: waiting, c: waiting })?.message).toContain(
      "all 3 agents. 2 are waiting for your answer — those prompts may be lost.",
    );
  });

  it("counts only whom it stops, against the team it stops them on", () => {
    expect(view(3, ["a", "b"], { c: working })?.message).toBe(
      `This requests a stop for 2 of its 3 agents.\n\nEach keeps ${KEEPS}`,
    );
  });

  it("speaks of one agent as one", () => {
    const one = view(1, ["a"], { a: working });
    expect(one?.message).toBe(
      `This requests a stop for its agent. 1 is in the middle of a turn — that work may be lost.\n\nIt keeps ${KEEPS}`,
    );
    expect(one?.confirmLabel).toBe("Suspend");
    expect(view(3, ["a"])?.message).toContain("This requests a stop for 1 of its 3 agents.");
  });

  it("asks nothing when it would stop nobody", () => {
    expect(view(2, [])).toBeNull();
  });
});
