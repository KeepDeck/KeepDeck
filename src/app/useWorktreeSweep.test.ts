// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { useWorktreeSweep } from "./useWorktreeSweep";
import type { WorktreeHousekeeping } from "./worktrees";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ws = (id: string, name = id, panes: Workspace["panes"] = []): Workspace =>
  ({ id, name, cwd: "/repo", worktreeBaseDir: null, panes }) as Workspace;

const pane = (id: string, cwd: string) =>
  ({ id, agentType: "codex", cwd, branch: "kd/x" }) as Workspace["panes"][number];

/** The trigger needs exactly one method, and its port says exactly that — so the
 * double is a real `WorktreeHousekeeping`, with no cast to escape the check. */
const sweep = vi.fn(async () => {});
const manager: WorktreeHousekeeping = { sweep };

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

  it("asks again whenever the deck changes", async () => {
    await render([ws("ws-1"), ws("ws-2")], true);
    expect(sweep).toHaveBeenCalledTimes(1);

    await render([ws("ws-1")], true);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("does not ask on a re-render that leaves the deck alone", async () => {
    // The deck store hands back the same array until something actually
    // changes, and this hook keys on exactly that. WHICH changes are worth an
    // IPC is the manager's call, not a rule duplicated here — a second opinion
    // about what a live root is was how the trigger and the answer drifted
    // apart (see worktrees.test.ts "does nothing when the live set is
    // unchanged").
    const workspaces = [ws("ws-1", "One", [pane("p1", "/wt/a")])];
    await render(workspaces, true);
    expect(sweep).toHaveBeenCalledTimes(1);

    await render(workspaces, true);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
