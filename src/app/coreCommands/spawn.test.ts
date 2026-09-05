// FIRST, before anything that reaches the mocked IPC: the doubles register
// when this module evaluates, and `../coreCommands` pulls the real
// `ipc/worktree` in if it gets there first.
import {
  AGENTS,
  HOST,
  repoMode,
  resetCoreCommandTestState,
  settingsState,
  setup,
  workspace,
} from "./testSupport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
  provisioningCard,
} from "../../domain/deck";
import { deliverTask } from "./deliverTask";
import { registerPaneInput } from "../paneInput";

beforeEach(() => {
  resetCoreCommandTestState();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("agent.spawn", () => {
  it("spawns a bare pane in a non-repo workspace and selects it", async () => {
    const { registry, deck } = setup([workspace({})]);
    const result = await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "codex", name: "helper" },
      HOST,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { paneId: string; worktree: unknown };
    expect(value.worktree).toBeNull();
    const ws = deck.workspaces[0];
    expect(ws.panes).toHaveLength(1);
    expect(ws.panes[0]).toMatchObject({ agentType: "codex", name: "helper" });
    expect(deck.selectWorkspace).toHaveBeenCalledWith("ws-1");
    expect(deck.selectPane).toHaveBeenCalledWith("ws-1", value.paneId);
  });

  it("provisions the first free worktree in a repo workspace with a base dir", async () => {
    repoMode.isRepo = true;
    const { registry, deck } = setup([
      workspace({ worktreeBaseDir: "/wt", panes: [{ id: "p0", agentType: "claude" }] }),
    ]);
    const result = await registry.execute("agent.spawn", { workspace: "web" }, HOST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pane = deck.workspaces[0].panes[1];
    expect(provisioningCard(pane)).toMatchObject({
      repo: "/repo",
      branch: "kd/web/2",
      index: 2,
    });
    expect(provisioningCard(pane)?.path.endsWith("kd-web-2")).toBe(true);
  });

  it("reports a refusal instead of a paneId that was never added", async () => {
    // The landing's own refusals, which this command translates. Reporting a
    // paneId for a pane that is not in the deck is the failure the switch
    // exists to prevent — and the worktree is already on disk by then.
    const { registry, createPane } = setup([workspace({})]);

    createPane.mockReturnValueOnce({ kind: "full" });
    const full = await registry.execute("agent.spawn", { workspace: "web" }, HOST);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.error.message).toBe(WORKSPACE_FULL_MESSAGE);

    createPane.mockReturnValueOnce({ kind: "gone" });
    const gone = await registry.execute("agent.spawn", { workspace: "web" }, HOST);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error.message).toBe(WORKSPACE_GONE_MESSAGE);
  });

  it("honors the global YOLO default, gated on the agent's support", async () => {
    settingsState.current = { defaultYolo: true };
    const { registry, deck } = setup([workspace({})]);

    await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "claude" },
      HOST,
    );
    expect(deck.workspaces[0].panes[0].yolo).toBe(true);

    await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "codex" },
      HOST,
    );
    // codex's fixture declares no support — the default must not leak, and
    // off never lands as an explicit false (sparse like every other surface).
    expect("yolo" in deck.workspaces[0].panes[1]).toBe(false);
  });

  it("refuses a blank workspace instead of spawning into the active one", async () => {
    // The third site of the same fix, and the one that went in without a test:
    // `workspace` is declared required, so reading it with the OPTIONAL reader
    // turned a blank one into "omitted", which resolves to the ACTIVE workspace
    // — a pane spawned somewhere the caller never named, reported as success.
    const { registry, deck, createPane } = setup([workspace({})]);

    const blank = await registry.execute("agent.spawn", { workspace: "  " }, HOST);

    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.message).toBe('argument "workspace" must not be blank');
    expect(createPane).not.toHaveBeenCalled();
    expect(deck.selectWorkspace).not.toHaveBeenCalled();
  });

  it("refuses an unknown agent type", async () => {
    const { registry } = setup([workspace({})]);
    const result = await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "gemini" },
      HOST,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "failed", message: 'unknown agent type "gemini"' },
    });
  });

  it("refuses an agent that does not support new sessions", async () => {
    const { registry } = setup([workspace({})]);
    const original = AGENTS[1].features;
    AGENTS[1].features = [
      { id: "session.history", label: "Session history" },
    ];
    try {
      const result = await registry.execute(
        "agent.spawn",
        { workspace: "web", agentType: "codex" },
        HOST,
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: "failed",
          message: 'agent type "codex" does not support new sessions',
        },
      });
    } finally {
      AGENTS[1].features = original;
    }
  });

  it("does not attach a delayed spawn to a replacement with the same id", async () => {
    let finishInspect!: (value: {
      isRepo: boolean;
      head: string;
      branch: string;
    }) => void;
    repoMode.inspect = () =>
      new Promise((resolve) => {
        finishInspect = resolve;
      });
    const workspaces = [workspace({})];
    const { registry, deck, createPane } = setup(workspaces);

    const pending = registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "codex" },
      HOST,
    );
    const replacement = workspace({ name: "replacement", cwd: "/replacement" });
    workspaces.splice(0, 1, replacement);
    finishInspect({ isRepo: false, head: "abc", branch: "main" });

    await expect(pending).resolves.toEqual({
      ok: false,
      error: {
        code: "failed",
        message: WORKSPACE_GONE_MESSAGE,
      },
    });
    expect(replacement.panes).toEqual([]);
    // The pane is never even offered: the workspace the spawn started in is
    // gone, and the command notices before shaping anything for it.
    expect(createPane).not.toHaveBeenCalled();
    expect(deck.selectWorkspace).not.toHaveBeenCalled();
  });

  it("delivers the task into the pane once its writer is live", async () => {
    vi.useFakeTimers();
    const { registry, deck } = setup([workspace({})]);
    const result = await registry.execute(
      "agent.spawn",
      { workspace: "web", task: "fix the header" },
      HOST,
    );
    expect(result.ok).toBe(true);
    const paneId = deck.workspaces[0].panes[0].id;
    const pasted: string[] = [];
    const written: string[] = [];
    // One entry carries both channels — TerminalPane registers them together.
    const off = registerPaneInput(paneId, {
      write: (t) => written.push(t),
      paste: (t) => pasted.push(t),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    off();
    // The task text is PASTED (xterm framing), the submit Enter is a separate
    // RAW write — a CR inside the paste payload would be content, not Enter.
    expect(pasted).toEqual(["fix the header"]);
    expect(written).toEqual(["\r"]);
  });
});

describe("deliverTask", () => {
  it("gives up when the pane's writer never appears", async () => {
    const delivered = await deliverTask("ghost-pane", "task", async () => {});
    expect(delivered).toBe(false);
  });
});
