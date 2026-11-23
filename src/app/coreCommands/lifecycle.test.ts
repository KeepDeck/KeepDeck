// FIRST, before anything that reaches the mocked IPC — see testSupport.
import { HOST, resetCoreCommandTestState, setup, workspace } from "./testSupport";
import { beforeEach, describe, expect, it } from "vitest";
import { refusalText } from "../../presentation/lifecycleWords";
import { registerPaneInput } from "../paneInput";
import { rosterActivity } from "./workspaces";

/**
 * The commands read the lifecycle machine's phase of a pane through the
 * orchestrator's reach (integration rows B17, B19): the one answer that
 * folds the machine's phase in — a pane being closed is down "leaving", one
 * being suspended down "suspending", one restarting on its way up. A pane
 * on its way out takes no input, and the agent is told why in the
 * presentation's words — the same refusal every surface says.
 */

beforeEach(() => {
  resetCoreCommandTestState();
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
    const { registry, reachOf } = setup([deck()]);
    reachOf.mockImplementation((paneId) => (paneId === "pane-2" ? { kind: "down", why: "leaving" } : { kind: "running" }));
    const written: string[] = [];
    const off = registerPaneInput("pane-2", { write: (t) => written.push(t), paste: (t) => written.push(t) });

    const result = await registry.execute("pane.write", { agent: "reviewer", text: "hello", submit: true }, HOST);
    off();

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain(refusalText({ kind: "targetLeaving" }));
    expect(written).toEqual([]);
  });

  it("says in the roster what the machine is doing to a pane, ahead of the turn status", () => {
    const working = { state: "working", since: 1 } as const;
    expect(rosterActivity({ kind: "down", why: "leaving" }, working)).toEqual({ state: "leaving" });
    expect(rosterActivity({ kind: "down", why: "suspending" }, working)).toEqual({ state: "suspending" });
    // A restart brings it back by itself: on its way up.
    expect(rosterActivity({ kind: "starting" }, undefined)).toEqual({ state: "starting" });
    expect(rosterActivity({ kind: "running" }, working)).toEqual(working);
  });

  it("writes into a live pane as before", async () => {
    const { registry } = setup([deck()]);
    const pasted: string[] = [];
    const off = registerPaneInput("pane-2", { write: () => true, paste: (t) => pasted.push(t) });

    const result = await registry.execute("pane.write", { agent: "reviewer", text: "hello" }, HOST);
    off();

    expect(result.ok).toBe(true);
    expect(pasted).toEqual(["hello"]);
  });
});
