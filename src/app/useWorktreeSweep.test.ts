// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { useWorktreeSweep } from "./useWorktreeSweep";
import type { WorktreeManager } from "./worktrees";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ws = (id: string, name = id, panes: Workspace["panes"] = []): Workspace =>
  ({ id, name, cwd: "/repo", worktreeBaseDir: null, panes }) as Workspace;

const pane = (id: string, cwd: string) =>
  ({ id, agentType: "codex", cwd, branch: "kd/x" }) as Workspace["panes"][number];

/** Only `sweep` is exercised here; the trigger knows nothing of the rest. */
const sweep = vi.fn(async () => {});
const manager = { sweep } as unknown as WorktreeManager;

function Probe({
  workspaces,
  ready,
}: {
  workspaces: Workspace[];
  ready: boolean;
}) {
  useWorktreeSweep(manager, workspaces, ready);
  return null;
}

describe("the worktree sweep trigger", () => {
  let root: Root;

  beforeEach(() => {
    sweep.mockClear();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (workspaces: Workspace[], ready: boolean) =>
    act(async () => root.render(createElement(Probe, { workspaces, ready })));

  it("passes the deck's readiness through — the manager decides, not the hook", async () => {
    await render([ws("ws-1")], false);
    expect(sweep).toHaveBeenLastCalledWith(false);

    await render([ws("ws-1")], true);
    expect(sweep).toHaveBeenLastCalledWith(true);
  });

  it("asks again when a workspace leaves", async () => {
    await render([ws("ws-1"), ws("ws-2")], true);
    expect(sweep).toHaveBeenCalledTimes(1);

    await render([ws("ws-1")], true);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("asks again when a pane's root leaves, even within one workspace", async () => {
    await render([ws("ws-1", "One", [pane("p1", "/wt/a")])], true);
    expect(sweep).toHaveBeenCalledTimes(1);

    await render([ws("ws-1", "One", [])], true);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("renames and re-renders do not ask — ids and roots key the dirs, not names", async () => {
    await render([ws("ws-1", "Old name")], true);
    await render([ws("ws-1", "New name")], true);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
