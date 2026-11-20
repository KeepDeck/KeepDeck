// FIRST, before anything that reaches the mocked IPC — see testSupport.
import { HOST, resetCoreCommandTestState, setup, workspace } from "./testSupport";
import { beforeEach, describe, expect, it } from "vitest";
import type { Snapshot } from "../../ipc/generated/lifecycle/Snapshot";
import { refusalText } from "../../presentation/lifecycleWords";
import { registerPaneInput } from "../paneInput";
import { rosterActivity } from "./workspaces";

/**
 * The commands read the lifecycle machine's snapshot (integration row B17):
 * a pane on its way out takes no input, and the agent is told why in the
 * presentation's words — the same refusal every surface says.
 */

beforeEach(() => {
  resetCoreCommandTestState();
});

const snapshotWith = (panes: Snapshot["panes"]): Snapshot => ({
  open: true,
  viewOnly: false,
  sessionsDown: false,
  forgotten: { workspaces: [], teams: [], panes: [] },
  workspaces: {},
  teams: {},
  gates: {},
  panes,
  commands: [],
});

describe("pane.write and the lifecycle", () => {
  const deck = () =>
    workspace({
      panes: [
        { id: "pane-1", agentType: "claude" },
        { id: "pane-2", agentType: "codex", name: "reviewer" },
      ],
    });

  it("refuses a pane the machine is taking down, in the presentation's words, and writes nothing", async () => {
    const { registry, lifecycle } = setup([deck()]);
    lifecycle.receive({ version: 1, snapshot: snapshotWith({ "pane-2": "leaving" }) });
    const written: string[] = [];
    const off = registerPaneInput("pane-2", { write: (t) => written.push(t), paste: (t) => written.push(t) });

    const result = await registry.execute("pane.write", { agent: "reviewer", text: "hello", submit: true }, HOST);
    off();

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain(refusalText({ kind: "targetLeaving" }));
    expect(written).toEqual([]);
  });

  /** Integration row B19: the roster's activity reads the machine's phase,
   * with words of its own for what the machine is doing to a pane. */
  it("names the machine's phase in the roster's activity, ahead of the turn status", () => {
    const working = { state: "working", since: 1 } as const;
    expect(rosterActivity({ kind: "running" }, working, "leaving")).toEqual({ state: "leaving" });
    expect(rosterActivity({ kind: "running" }, working, "suspending")).toEqual({ state: "suspending" });
    expect(rosterActivity({ kind: "running" }, undefined, "restarting")).toEqual({ state: "restarting" });
    expect(rosterActivity({ kind: "running" }, working, "live")).toEqual(working);
  });

  it("writes into a live pane as before", async () => {
    const { registry, lifecycle } = setup([deck()]);
    lifecycle.receive({ version: 1, snapshot: snapshotWith({ "pane-2": "live" }) });
    const pasted: string[] = [];
    const off = registerPaneInput("pane-2", { write: () => true, paste: (t) => pasted.push(t) });

    const result = await registry.execute("pane.write", { agent: "reviewer", text: "hello" }, HOST);
    off();

    expect(result.ok).toBe(true);
    expect(pasted).toEqual(["hello"]);
  });
});
