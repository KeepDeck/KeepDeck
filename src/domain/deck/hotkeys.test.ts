import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../agents";
import { closeHotkeyTarget, maximizeHotkeyTarget } from "./hotkeys";
import type { Workspace } from "./workspaces";

const agents: AgentInfo[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    installed: true,
    path: null,
  },
];

const ws = (id: string, panes: Workspace["panes"]): Workspace => ({
  id,
  name: id,
  cwd: "/tmp/repo",
  worktreeBaseDir: null,
  panes,
});

describe("closeHotkeyTarget", () => {
  it("targets the active workspace's selected pane with its display title", () => {
    const workspaces = [
      ws("ws-1", [{ id: "pane-1" }, { id: "pane-2", agentType: "claude" }]),
    ];
    expect(
      closeHotkeyTarget(workspaces, "ws-1", { "ws-1": { select: "pane-2" } }, agents),
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
      closeHotkeyTarget(workspaces, "ws-1", { "ws-1": { select: "pane-1" } }, agents),
    ).toEqual({ kind: "agent", wsId: "ws-1", paneId: "pane-1", label: "api" });
  });

  it("falls back to a solo pane when nothing is selected", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1", agentType: "claude" }])];
    expect(closeHotkeyTarget(workspaces, "ws-1", {}, agents)).toEqual({
      kind: "agent",
      wsId: "ws-1",
      paneId: "pane-1",
      label: "Claude Code 1",
    });
  });

  it("returns null when several panes leave no selection to act on", () => {
    const workspaces = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];
    expect(closeHotkeyTarget(workspaces, "ws-1", {}, agents)).toBeNull();
  });

  it("treats a stale selection as no selection", () => {
    const multi = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];
    expect(
      closeHotkeyTarget(multi, "ws-1", { "ws-1": { select: "pane-9" } }, agents),
    ).toBeNull();
    // …but a solo pane is still unambiguous.
    const solo = [ws("ws-1", [{ id: "pane-1" }])];
    expect(
      closeHotkeyTarget(solo, "ws-1", { "ws-1": { select: "pane-9" } }, agents),
    ).toMatchObject({ paneId: "pane-1" });
  });

  it("targets the workspace itself when it has no panes", () => {
    expect(closeHotkeyTarget([ws("ws-1", [])], "ws-1", {}, agents)).toEqual({
      kind: "workspace",
      wsId: "ws-1",
    });
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
      closeHotkeyTarget(workspaces, "ws-1", { "ws-2": { select: "pane-3" } }, agents),
    ).toBeNull();
  });
});

describe("maximizeHotkeyTarget", () => {
  const multi = [ws("ws-1", [{ id: "pane-1" }, { id: "pane-2" }])];

  it("maximizes the selected pane", () => {
    expect(
      maximizeHotkeyTarget(multi, "ws-1", { "ws-1": { select: "pane-2" } }),
    ).toEqual({ wsId: "ws-1", paneId: "pane-2" });
  });

  it("restores the maximized pane even when the selection points elsewhere", () => {
    expect(
      maximizeHotkeyTarget(multi, "ws-1", {
        "ws-1": { focus: "pane-1", select: "pane-2" },
      }),
    ).toEqual({ wsId: "ws-1", paneId: "pane-1" });
  });

  it("falls back to the selection when the focus entry is stale", () => {
    expect(
      maximizeHotkeyTarget(multi, "ws-1", {
        "ws-1": { focus: "pane-9", select: "pane-2" },
      }),
    ).toEqual({ wsId: "ws-1", paneId: "pane-2" });
  });

  it("returns null for a solo pane — it is already full-size", () => {
    const solo = [ws("ws-1", [{ id: "pane-1" }])];
    expect(
      maximizeHotkeyTarget(solo, "ws-1", { "ws-1": { select: "pane-1" } }),
    ).toBeNull();
  });

  it("returns null when the selection is stale or absent", () => {
    expect(maximizeHotkeyTarget(multi, "ws-1", {})).toBeNull();
    expect(
      maximizeHotkeyTarget(multi, "ws-1", { "ws-1": { select: "pane-9" } }),
    ).toBeNull();
  });

  it("returns null for an unknown active workspace or an empty one", () => {
    expect(maximizeHotkeyTarget([], "ws-1", {})).toBeNull();
    expect(maximizeHotkeyTarget([ws("ws-1", [])], "ws-1", {})).toBeNull();
  });
});
