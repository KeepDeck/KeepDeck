import { describe, expect, it } from "vitest";
import { team, teamedWorkspace, workspace } from "../domain/deck/reducer.testSupport";
import type { Workspace } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import {
  attentionTrigger,
  needsYouAge,
  needsYouRows,
  nextNeedsYou,
  type NeedsYouRow,
} from "./needsYouView";

const MIN = 60_000;
const NOW = 100 * MIN;
const AGENTS = [{ id: "claude", label: "Claude" }];

const waiting = (minsAgo: number): PaneActivity => ({
  state: "waiting",
  since: NOW - minsAgo * MIN,
  reason: "permission",
});
const failed = (minsAgo: number): PaneActivity => ({
  state: "failed",
  at: NOW - minsAgo * MIN,
  error: "rate_limit",
});

const TEAM: Workspace = teamedWorkspace("ws-a", ["p1", "p2", "p3", "p4"]);
const LOOSE: Workspace = {
  ...workspace("ws-b", []),
  teams: [team("t-b")],
  panes: [
    { id: "p5", name: "scout", team: { teamId: "t-b", role: "lead" } },
    { id: "p6", idle: { reason: "suspended", at: "x" }, team: { teamId: "t-b", role: "impl-1" } },
    // Legacy: a pane outside every team has no card to be reached from.
    { id: "p7" },
  ],
};

const rows = (activities: Record<string, PaneActivity>) =>
  needsYouRows([TEAM, LOOSE], new Map(Object.entries(activities)), AGENTS);

describe("needsYouRows", () => {
  it("lists only waiting and failed agents, across every workspace", () => {
    const found = rows({
      p1: { state: "working", since: NOW },
      p2: { state: "done", at: NOW, interrupted: false },
      p3: waiting(2),
      p5: failed(1),
    });
    expect(found.map((r) => r.paneId)).toEqual(["p5", "p3"]);
  });

  it("puts failed first, then the longest-blocked first within a tone", () => {
    const found = rows({ p1: waiting(1), p2: failed(1), p3: waiting(9), p4: failed(5) });
    expect(found.map((r) => r.paneId)).toEqual(["p4", "p2", "p3", "p1"]);
  });

  it("skips an idle pane whatever its last activity said, and a pane outside every team", () => {
    expect(rows({ p6: waiting(3), p7: failed(2) })).toEqual([]);
  });

  it("names the agent, where it is, why and for how long", () => {
    const [teamed] = rows({ p3: waiting(4) });
    expect(teamed).toEqual({
      wsId: "ws-a",
      paneId: "p3",
      tone: "waiting",
      title: "Claude 3",
      where: "ws-a · team-1 · p3",
      label: "Needs approval",
      since: NOW - 4 * MIN,
    } satisfies NeedsYouRow);
    expect(needsYouAge(teamed, NOW)).toBe("4m");
    const [loose] = rows({ p5: failed(0) });
    expect(loose).toMatchObject({ title: "scout", where: "ws-b · t-b · lead", tone: "failed" });
    expect(needsYouAge(loose, NOW)).toBe("now");
  });
});

describe("attentionTrigger", () => {
  const row = (tone: NeedsYouRow["tone"]): NeedsYouRow => ({
    wsId: "w",
    paneId: "p",
    tone,
    title: "t",
    where: "w",
    label: "l",
    since: 0,
  });

  it("counts who needs you, in the loudest tone, even with the bell off", () => {
    expect(attentionTrigger([row("waiting")], null)).toEqual({
      kind: "need",
      tone: "waiting",
      text: "1 needs you",
      label: "1 agent needs you",
    });
    // Rows arrive louder first (domain blockedAgents), so the first is loudest.
    expect(attentionTrigger([row("failed"), row("waiting")], { unread: 3 })).toMatchObject({
      kind: "need",
      tone: "failed",
      text: "2 need you",
      label: "2 agents need you",
    });
  });

  it("falls back to the bell with its unread badge, or to nothing", () => {
    expect(attentionTrigger([], { unread: 0 })).toEqual({
      kind: "bell",
      badge: null,
      label: "Notifications",
    });
    expect(attentionTrigger([], { unread: 120 })).toMatchObject({
      badge: "99+",
      label: "Notifications (120 unread)",
    });
    expect(attentionTrigger([], null)).toBeNull();
  });
});

describe("nextNeedsYou", () => {
  const at = (paneId: string): NeedsYouRow => ({
    wsId: "w",
    paneId,
    tone: "waiting",
    title: paneId,
    where: "w",
    label: "l",
    since: 0,
  });
  const rows = [at("a"), at("b"), at("c")];

  it("walks the list from the agent the person is on, wrapping at the end", () => {
    expect(nextNeedsYou(rows, { wsId: "w", paneId: "a" })?.paneId).toBe("b");
    expect(nextNeedsYou(rows, { wsId: "w", paneId: "c" })?.paneId).toBe("a");
  });

  it("starts at the top from anywhere else, and has nowhere to go with nobody waiting", () => {
    expect(nextNeedsYou(rows, null)?.paneId).toBe("a");
    expect(nextNeedsYou(rows, { wsId: "other", paneId: "a" })?.paneId).toBe("a");
    expect(nextNeedsYou([], { wsId: "w", paneId: "a" })).toBeNull();
  });
});
