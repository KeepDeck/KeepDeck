// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { useSkillsPrune } from "./useSkillsPrune";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const wire = vi.hoisted(() => ({
  pruneSkills: vi.fn(async () => {}),
  disarmSkills: vi.fn(async () => {}),
  stageSkills: vi.fn(async () => null),
}));
vi.mock("../ipc/skills", () => wire);

const ws = (id: string, name = id, panes: Workspace["panes"] = []): Workspace =>
  ({ id, name, cwd: "/repo", worktreeBaseDir: null, panes }) as Workspace;

function Probe({ workspaces, ready }: { workspaces: Workspace[]; ready: boolean }) {
  useSkillsPrune(workspaces, ready);
  return null;
}

describe("the skills prune sweep", () => {
  let root: Root;

  beforeEach(() => {
    wire.pruneSkills.mockClear();
    wire.disarmSkills.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const mount = (workspaces: Workspace[], ready: boolean) =>
    act(async () => root.render(createElement(Probe, { workspaces, ready })));

  it("never sweeps before the deck is hydrated", async () => {
    await mount([ws("ws-1")], false);
    expect(wire.pruneSkills).not.toHaveBeenCalled();
  });

  it("sweeps once at boot and again when a workspace closes", async () => {
    await mount([ws("ws-1"), ws("ws-2")], true);
    expect(wire.pruneSkills).toHaveBeenCalledTimes(1);
    expect(wire.pruneSkills).toHaveBeenLastCalledWith(["ws-1", "ws-2"]);

    await mount([ws("ws-1")], true);
    expect(wire.pruneSkills).toHaveBeenCalledTimes(2);
    expect(wire.pruneSkills).toHaveBeenLastCalledWith(["ws-1"]);
  });

  it("an empty hydrated deck sweeps everything", async () => {
    await mount([], true);
    expect(wire.pruneSkills).toHaveBeenLastCalledWith([]);
  });

  it("renames and re-renders do not re-sweep — ids key the dirs", async () => {
    const before = [ws("ws-1", "Old name")];
    await mount(before, true);
    await mount([ws("ws-1", "New name")], true);
    expect(wire.pruneSkills).toHaveBeenCalledTimes(1);
  });

  it("a closing workspace's worktrees are disarmed, even late-added ones", async () => {
    const wt = (id: string, cwd: string) =>
      ({ id, agentType: "codex", cwd, branch: "kd/x" }) as Workspace["panes"][number];
    await mount([ws("ws-1", "One", [wt("p1", "/wt/a")])], true);
    // A worktree pane lands AFTER the boot sweep…
    await mount([ws("ws-1", "One", [wt("p1", "/wt/a"), wt("p2", "/wt/b")])], true);
    // …and the close still disarms BOTH of the workspace's worktrees.
    await mount([], true);
    expect(wire.disarmSkills).toHaveBeenLastCalledWith(["/wt/a", "/wt/b"]);
    expect(wire.pruneSkills).toHaveBeenLastCalledWith([]);
  });

  it("a closed PANE's cwd is disarmed too — unless another pane still uses it", async () => {
    const wt = (id: string, cwd: string) =>
      ({ id, agentType: "codex", cwd, branch: "kd/x" }) as Workspace["panes"][number];
    const shared = (id: string) =>
      ({ id, agentType: "claude" }) as Workspace["panes"][number];
    // Two panes in the workspace cwd plus one worktree pane.
    await mount(
      [ws("ws-1", "One", [shared("p1"), shared("p2"), wt("p3", "/wt/a")])],
      true,
    );

    // The worktree pane closes: its cwd is nobody's now — disarm it.
    await mount([ws("ws-1", "One", [shared("p1"), shared("p2")])], true);
    expect(wire.disarmSkills).toHaveBeenLastCalledWith(["/wt/a"]);

    // One of the shared-cwd panes closes: the OTHER still runs there — the
    // workspace cwd must stay armed. The root set is unchanged, so the
    // sweep doesn't even re-run, and "/repo" is never disarmed.
    await mount([ws("ws-1", "One", [shared("p1")])], true);
    expect(wire.disarmSkills).not.toHaveBeenCalledWith(["/repo"]);
    expect(
      (wire.disarmSkills.mock.calls as unknown as string[][][]).some((call) =>
        call[0]?.includes("/repo"),
      ),
    ).toBe(false);
  });
});
