// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { useSkillsPrune } from "./useSkillsPrune";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const wire = vi.hoisted(() => ({ pruneSkills: vi.fn(async () => {}) }));
vi.mock("../ipc/skills", () => wire);

const ws = (id: string, name = id): Workspace =>
  ({ id, name, cwd: "/repo", worktreeBaseDir: null, panes: [] }) as Workspace;

function Probe({ workspaces, ready }: { workspaces: Workspace[]; ready: boolean }) {
  useSkillsPrune(workspaces, ready);
  return null;
}

describe("the skills prune sweep", () => {
  let root: Root;

  beforeEach(() => {
    wire.pruneSkills.mockClear();
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
});
