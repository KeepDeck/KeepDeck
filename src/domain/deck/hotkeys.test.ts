import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../agents";
import {
  closeHotkeyTarget,
  maximizeHotkeyTarget,
  paneHotkeyTarget,
} from "./hotkeys";
import type { Team } from "./teams";
import type { Workspace } from "./workspaces";
import { createWorkspaceInstance } from "../workspaceInstance";

const agents: AgentInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    features: [],
    installed: true,
    path: null,
  },
];

const team = (id: string): Team => ({
  id,
  name: id,
  location: { kind: "attached", cwd: "/tmp/repo" },
});

/** A workspace with one team, `team-1`, and every pane on it — a hotkey
 * only ever targets a pane inside the open team, so that is where the
 * suite lives. A pane's role is its own id: unique, which is all that is
 * asked of it here. */
const ws = (id: string, panes: Workspace["panes"], teams: Team[] = [team("team-1")]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/tmp/repo",
  worktreeBaseDir: null,
  teams,
  panes: panes.map((pane) => ({ ...pane, team: pane.team ?? { teamId: "team-1", role: pane.id } })),
});

/** ws-1's view with team-1 open, plus whatever the case sets. */
const v = (view: Record<string, unknown> = {}) => ({ "ws-1": { teamOpen: "team-1", ...view } });

describe("closeHotkeyTarget", () => {
  it("targets the active workspace's selected pane with its display title", () => {
    const workspaces = [
      ws("ws-1", [{ id: "pane-1" }, { id: "pane-2", agentType: "claude" }]),
    ];
    expect(
      closeHotkeyTarget(workspaces, "ws-1", v({ select: "pane-2" }), agents),
    ).toEqual({
      kind: "agent",
      wsId: "ws-1",
      paneId: "pane-2",
      label: "Claude Code 2",
    });
  });

  it("prefers the pane's manual name for the confirm label", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1", name: "api" }])];
    expect(
      closeHotkeyTarget(workspaces, "ws-1", v({ select: "pane-1" }), agents),
    ).toEqual({ kind: "agent", wsId: "ws-1", paneId: "pane-1", label: "api" });
  });

  it("falls back to a solo pane when nothing is selected", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1", agentType: "claude" }])];
    expect(closeHotkeyTarget(workspaces, "ws-1", v(), agents)).toEqual({
      kind: "agent",
      wsId: "ws-1",
      paneId: "pane-1",
      label: "Claude Code 1",
    });
  });

  it("returns null when several panes leave no selection to act on", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];
    expect(closeHotkeyTarget(workspaces, "ws-1", v(), agents)).toBeNull();
  });

  it("treats a stale selection as no selection", () => {
    const multi = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];
    expect(
      closeHotkeyTarget(multi, "ws-1", v({ select: "pane-9" }), agents),
    ).toBeNull();
    // …but a solo pane is still unambiguous.
    const solo = [ws("ws-1", [{ id: "pane-1" }])];
    expect(
      closeHotkeyTarget(solo, "ws-1", v({ select: "pane-9" }), agents),
    ).toMatchObject({ paneId: "pane-1" });
  });

  it("targets the workspace itself only when it has neither panes nor teams", () => {
    expect(closeHotkeyTarget([ws("ws-1", [], [])], "ws-1", {}, agents)).toEqual({
      kind: "workspace",
      wsId: "ws-1",
    });
    // A team with nobody on it is still a team: the workspace is not empty,
    // and inside the empty team there is no pane to close either.
    expect(closeHotkeyTarget([ws("ws-1", [])], "ws-1", {}, agents)).toBeNull();
    expect(closeHotkeyTarget([ws("ws-1", [])], "ws-1", v(), agents)).toBeNull();
  });

  it("targets nothing at the cards level, whatever the stored selection says", () => {
    // No team open: no pane is in front of the person, so a habituated
    // ⌘W closes nothing — not the workspace, not a pane a stale view names.
    const workspaces = [ws("ws-1", [{ id: "pane-1" }])];
    expect(closeHotkeyTarget(workspaces, "ws-1", {}, agents)).toBeNull();
    expect(closeHotkeyTarget(workspaces, "ws-1", { "ws-1": { select: "pane-1" } }, agents)).toBeNull();
  });

  it("never targets another team's pane, even the selected one", () => {
    const two = [
      ws(
        "ws-1",
        [
          { id: "pane-1", team: { teamId: "team-1", role: "lead" } },
          { id: "pane-2", agentType: "claude", team: { teamId: "team-2", role: "lead" } },
          { id: "pane-3", team: { teamId: "team-2", role: "impl-1" } },
        ],
        [team("team-1"), team("team-2")],
      ),
    ];
    // Inside team-2 a selection on team-1's pane is stale — two candidates
    // remain, so nothing is targeted...
    expect(
      closeHotkeyTarget(two, "ws-1", { "ws-1": { teamOpen: "team-2", select: "pane-1" } }, agents),
    ).toBeNull();
    // ...and where the open team has one pane, THAT pane is the solo
    // fallback, never the foreign one the view names.
    const solo = [{ ...two[0], panes: two[0].panes.slice(0, 2) }];
    expect(
      closeHotkeyTarget(solo, "ws-1", { "ws-1": { teamOpen: "team-2", select: "pane-1" } }, agents),
    ).toMatchObject({ paneId: "pane-2", label: "Claude Code 2" });
  });

  it("returns null for an unknown active workspace", () => {
    expect(closeHotkeyTarget([], "ws-1", {}, agents)).toBeNull();
  });

  it("ignores another workspace's selection", () => {
    const workspaces = [
      ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }]),
      ws("ws-2", [{ id: "pane-3" }]),
    ];
    expect(
      closeHotkeyTarget(
        workspaces,
        "ws-1",
        { ...v(), "ws-2": { teamOpen: "team-1", select: "pane-3" } },
        agents,
      ),
    ).toBeNull();
  });

  it("never targets a minimized pane — a confirm must not close an off-screen agent", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];
    const view = v({ select: "pane-2", minimized: ["pane-2"] });
    expect(closeHotkeyTarget(workspaces, "ws-1", view, agents)).toMatchObject({
      // The selection sits on the minimized pane; the visible-solo fallback
      // targets what's actually on screen instead.
      paneId: "pane-1",
    });
  });

  it("treats the one still-visible pane as the unambiguous target", () => {
    // Numbering stays by ORIGINAL position: pane-2 is "Claude Code 2" even
    // while pane-1 is minimized.
    const workspaces = [
      ws("ws-1", [{ id: "pane-1" }, { id: "pane-2", agentType: "claude" }]),
    ];
    expect(
      closeHotkeyTarget(workspaces, "ws-1", v({ minimized: ["pane-1"] }), agents),
    ).toEqual({
      kind: "agent",
      wsId: "ws-1",
      paneId: "pane-2",
      label: "Claude Code 2",
    });
  });

  it("returns null when every pane is minimized", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1" }])];
    expect(
      closeHotkeyTarget(workspaces, "ws-1", v({ select: "pane-1", minimized: ["pane-1"] }), agents),
    ).toBeNull();
  });
});

describe("paneHotkeyTarget", () => {
  it("resolves the same agent ⌘W would, so the two chords never disagree", () => {
    const workspaces = [
      ws("ws-1", [{ id: "pane-1" }, { id: "pane-2", agentType: "claude" }]),
    ];
    const viewByWs = v({ select: "pane-2" });
    const close = closeHotkeyTarget(workspaces, "ws-1", viewByWs, agents);
    expect(paneHotkeyTarget(workspaces, "ws-1", viewByWs, agents)).toEqual({
      wsId: "ws-1",
      paneId: "pane-2",
      label: "Claude Code 2",
    });
    expect(close).toEqual({ kind: "agent", wsId: "ws-1", paneId: "pane-2", label: "Claude Code 2" });
  });

  it("has nothing to act on in an empty workspace — unlike close, which takes the workspace", () => {
    const workspaces = [ws("ws-1", [], [])];
    expect(paneHotkeyTarget(workspaces, "ws-1", {}, agents)).toBeNull();
    expect(closeHotkeyTarget(workspaces, "ws-1", {}, agents)).toEqual({
      kind: "workspace",
      wsId: "ws-1",
    });
  });

  it("has nothing to act on at the cards level", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1" }])];
    expect(paneHotkeyTarget(workspaces, "ws-1", {}, agents)).toBeNull();
    expect(paneHotkeyTarget(workspaces, "ws-1", v(), agents)).toMatchObject({ paneId: "pane-1" });
  });

  it("never targets a minimized pane — a blind chord must not hit an off-screen agent", () => {
    const workspaces = [
      ws("ws-1", [{ id: "pane-1" }, { id: "pane-2", agentType: "claude" }]),
    ];
    expect(
      paneHotkeyTarget(workspaces, "ws-1", v({ select: "pane-1", minimized: ["pane-1"] }), agents),
      // pane-2 is the only visible one, so it becomes the unambiguous target.
    ).toMatchObject({ paneId: "pane-2" });
  });

  it("returns null when several visible panes leave no selection", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];
    expect(paneHotkeyTarget(workspaces, "ws-1", v(), agents)).toBeNull();
    expect(paneHotkeyTarget(workspaces, "nope", v(), agents)).toBeNull();
  });

  it("never targets a suspended pane placed in the tray", () => {
    const workspaces = [
      ws("ws-1", [
        {
          id: "pane-1",
          idle: {
            reason: "suspended",
            at: "2026-07-29T10:00:00.000Z",
          },
        },
        { id: "pane-2", agentType: "claude" },
        { id: "pane-3", agentType: "claude" },
      ]),
    ];
    expect(
      paneHotkeyTarget(workspaces, "ws-1", v({ select: "pane-1", suspendedTray: ["pane-1"] }), agents),
    ).toMatchObject({ paneId: "pane-2" });
    // Keeping the pane retains the existing behavior: its card is a valid
    // target (the suspend command will then explain that it is stopped).
    expect(
      paneHotkeyTarget(workspaces, "ws-1", v({ select: "pane-1" }), agents),
    ).toMatchObject({ paneId: "pane-1" });
  });
});

describe("maximizeHotkeyTarget", () => {
  const multi = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];

  it("maximizes the selected pane", () => {
    expect(
      maximizeHotkeyTarget(multi, "ws-1", v({ select: "pane-2" })),
    ).toEqual({ wsId: "ws-1", paneId: "pane-2" });
  });

  it("restores the maximized pane even when the selection points elsewhere", () => {
    expect(
      maximizeHotkeyTarget(multi, "ws-1", v({ focus: "pane-1", select: "pane-2" })),
    ).toEqual({ wsId: "ws-1", paneId: "pane-1" });
  });

  it("falls back to the selection when the focus entry is stale", () => {
    expect(
      maximizeHotkeyTarget(multi, "ws-1", v({ focus: "pane-9", select: "pane-2" })),
    ).toEqual({ wsId: "ws-1", paneId: "pane-2" });
  });

  it("returns null for a solo pane — it is already full-size", () => {
    const solo = [ws("ws-1", [{ id: "pane-1" }])];
    expect(
      maximizeHotkeyTarget(solo, "ws-1", v({ select: "pane-1" })),
    ).toBeNull();
  });

  it("returns null when the selection is stale or absent", () => {
    expect(maximizeHotkeyTarget(multi, "ws-1", v())).toBeNull();
    expect(
      maximizeHotkeyTarget(multi, "ws-1", v({ select: "pane-9" })),
    ).toBeNull();
  });

  it("returns null for an unknown active workspace, an empty one, or the cards level", () => {
    expect(maximizeHotkeyTarget([], "ws-1", {})).toBeNull();
    expect(maximizeHotkeyTarget([ws("ws-1", [])], "ws-1", v())).toBeNull();
    // Two panes, but no team open: the slice is empty.
    expect(maximizeHotkeyTarget(multi, "ws-1", { "ws-1": { select: "pane-2" } })).toBeNull();
  });

  it("returns null when minimizing leaves one visible pane — already full-size", () => {
    // Writing a focus here would be masked by the render (visible-solo never
    // maximizes) but spring a surprise maximize on the next restore.
    const view = v({ select: "pane-2", minimized: ["pane-1"] });
    expect(maximizeHotkeyTarget(multi, "ws-1", view)).toBeNull();
  });

  it("never picks a minimized pane as the maximize target", () => {
    const three = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }, { id: "pane-3" }])];
    expect(
      maximizeHotkeyTarget(three, "ws-1", v({ select: "pane-3", minimized: ["pane-3"] })),
    ).toBeNull();
  });

  it("does not maximize a suspended tray pane or count it as visible", () => {
    const workspaces = [
      ws("ws-1", [
        {
          id: "pane-1",
          idle: {
            reason: "suspended",
            at: "2026-07-29T10:00:00.000Z",
          },
        },
        { id: "pane-2" },
      ]),
    ];
    expect(
      maximizeHotkeyTarget(
        workspaces,
        "ws-1",
        v({ select: "pane-1", suspendedTray: ["pane-1"] }),
      ),
    ).toBeNull();
  });
});
