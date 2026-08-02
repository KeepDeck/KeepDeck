import {
  AGENTS,
  HOST,
  repoMode,
  resetCoreCommandTestState,
  settingsState,
  setup,
  workspace,
} from "./coreCommands/testSupport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_FULL_MESSAGE,
  WORKSPACE_GONE_MESSAGE,
} from "../domain/deck";
import { registerPaneInput } from "./paneInput";
import { deliverTask } from "./coreCommands";

beforeEach(() => {
  resetCoreCommandTestState();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("workspace commands", () => {
  it("lists workspaces with active flag and header titles", async () => {
    const { registry, deck } = setup([
      workspace({ panes: [{ id: "p1", agentType: "claude" }] }),
      workspace({ id: "ws-2", name: "site", cwd: "/site" }),
    ]);
    vi.mocked(deck.viewOf).mockImplementation((workspaceId) =>
      workspaceId === "ws-1" ? { select: "p1" } : {},
    );
    const result = await registry.execute("workspace.list", {}, HOST);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toEqual([
        {
          id: "ws-1",
          name: "web",
          cwd: "/repo",
          active: true,
          panes: [
            {
              id: "p1",
              title: "Claude 1",
              agentType: "claude",
              branch: null,
              cwd: "/repo",
            },
          ],
        },
        {
          id: "ws-2",
          name: "site",
          cwd: "/site",
          active: false,
          panes: [],
        },
      ]);
  });

  it("resolves the exact active input target without guessing", async () => {
    const { registry, deck } = setup([
      workspace({
        panes: [
          { id: "p1", agentType: "claude" },
          { id: "p2", agentType: "codex" },
        ],
      }),
    ]);
    vi.mocked(deck.viewOf).mockReturnValue({ select: "p2" });

    const selected = await registry.execute("pane.target", {}, HOST);
    expect(selected).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", paneId: "p2" },
    });

    vi.mocked(deck.viewOf).mockReturnValue({});
    const ambiguous = await registry.execute("pane.target", {}, HOST);
    expect(ambiguous).toEqual({
      ok: false,
      error: {
        code: "failed",
        message: 'no agent selected in workspace "web"',
      },
    });
  });

  it("switches by case-insensitive name and refuses unknowns", async () => {
    const { registry, deck } = setup([
      workspace({}),
      workspace({ id: "ws-2", name: "site" }),
    ]);
    const ok = await registry.execute("workspace.switch", { workspace: "SITE" }, HOST);
    expect(ok).toEqual({ ok: true, value: { workspaceId: "ws-2" } });
    expect(deck.selectWorkspace).toHaveBeenCalledWith("ws-2");

    const bad = await registry.execute("workspace.switch", { workspace: "nope" }, HOST);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toBe('no workspace "nope"');
  });
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
    expect(pane.provisioning).toMatchObject({
      repo: "/repo",
      branch: "kd/web/2",
      workspace: "web",
      index: 2,
    });
    expect(pane.provisioning?.path?.endsWith("kd-web-2")).toBe(true);
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

describe("agent.focus / agent.close / pane.write", () => {
  const twoPanes = () =>
    workspace({
      panes: [
        { id: "p1", agentType: "claude" },
        { id: "p2", agentType: "codex", name: "reviewer" },
      ],
    });

  it("focuses a pane by name in the active workspace", async () => {
    const { registry, deck, activatePane } = setup([twoPanes()]);
    const result = await registry.execute("agent.focus", { agent: "reviewer" }, HOST);
    expect(result).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", paneId: "p2" },
    });
    expect(deck.selectPane).toHaveBeenCalledWith("ws-1", "p2");
    expect(activatePane).toHaveBeenCalledWith("ws-1", "p2");
  });

  it("close opens the confirm dialog with the header's label", async () => {
    const { registry, requestCloseAgent } = setup([twoPanes()]);
    const result = await registry.execute("agent.close", { agent: "claude 1" }, HOST);
    expect(result.ok).toBe(true);
    expect(requestCloseAgent).toHaveBeenCalledWith("ws-1", "p1", "Claude 1");
  });

  it("suspends the addressed pane without the confirm dialog", async () => {
    const { registry, suspendAgent, requestCloseAgent } = setup([twoPanes()]);
    const result = await registry.execute("agent.suspend", { agent: "reviewer" }, HOST);
    expect(result).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", paneId: "p2" },
    });
    expect(suspendAgent).toHaveBeenCalledWith("ws-1", "p2");
    // Nothing is destroyed, so it does not borrow the close flow's gate.
    expect(requestCloseAgent).not.toHaveBeenCalled();
  });

  it("reports the flow's own reason for refusing, not a second guess at it", async () => {
    const { registry, suspendAgent } = setup([
      workspace({
        panes: [
          { id: "p1", agentType: "claude", remoteEndpoint: "ws://vps:4500" },
        ],
      }),
    ]);
    suspendAgent.mockResolvedValueOnce("remote");

    const result = await registry.execute("agent.suspend", {}, HOST);

    expect(result.ok).toBe(false);
    // The caller hears why: a remote pane's session lives on the server, so
    // stopping the local client would not park it.
    if (!result.ok) expect(result.error.message).toContain("remote server");
  });

  it("resumes a stopped pane, and refuses one that is already running", async () => {
    const { registry, resumeAgent } = setup([
      workspace({
        panes: [
          { id: "p1", agentType: "claude", idle: { reason: "parked" } },
          { id: "p2", agentType: "codex", name: "live" },
        ],
      }),
    ]);

    resumeAgent.mockReturnValueOnce("resuming");
    const ok = await registry.execute("agent.resume", { agent: "p1" }, HOST);
    expect(ok).toEqual({ ok: true, value: { workspaceId: "ws-1", paneId: "p1" } });
    expect(resumeAgent).toHaveBeenCalledWith("ws-1", "p1");

    // Without this inverse an automation that suspends an agent strands it.
    // And the flow's own answer decides — reporting success for a resume that
    // did nothing is what the sibling command was fixed for.
    resumeAgent.mockReturnValueOnce("running");
    const already = await registry.execute("agent.resume", { agent: "live" }, HOST);
    expect(already.ok).toBe(false);
    if (!already.ok) expect(already.error.message).toContain("already running");
  });

  it("pastes text into the addressed pane; submit sends Enter as a separate raw write", async () => {
    const { registry } = setup([twoPanes()]);
    const pasted: string[] = [];
    const written: string[] = [];
    const off = registerPaneInput("p2", {
      write: (t) => written.push(t),
      paste: (t) => pasted.push(t),
    });
    const result = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello", submit: true },
      HOST,
    );
    off();
    expect(result.ok).toBe(true);
    expect(pasted).toEqual(["hello"]);
    // Enter rides outside the paste — see deliverTask for why a "\r" inside the
    // pasted payload would be content, not a submit.
    expect(written).toEqual(["\r"]);
  });

  it("mode:'type' writes raw keystrokes with LF newlines — no paste, so no collapse", async () => {
    const { registry } = setup([twoPanes()]);
    const pasted: string[] = [];
    const written: string[] = [];
    const off = registerPaneInput("p2", {
      write: (t) => written.push(t),
      paste: (t) => pasted.push(t),
    });
    const result = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "line one\r\nline two\rthird", mode: "type", submit: true },
      HOST,
    );
    off();
    expect(result.ok).toBe(true);
    // Raw TYPE channel only — no bracketed paste, so agents don't fold it into
    // a [Pasted …] placeholder. CR is normalised to LF (a raw CR would submit).
    expect(pasted).toEqual([]);
    expect(written).toEqual(["line one\nline two\nthird", "\r"]);
  });

  it("mode:'type' works on a TYPE-only pane (no paste channel needed)", async () => {
    const { registry } = setup([twoPanes()]);
    const written: string[] = [];
    const off = registerPaneInput("p2", { write: (t) => written.push(t) });
    const result = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello", mode: "type" },
      HOST,
    );
    off();
    expect(result.ok).toBe(true);
    expect(written).toEqual(["hello"]);
  });

  it("can activate the exact pane after a successful write", async () => {
    const { registry, activatePane } = setup([twoPanes()]);
    const off = registerPaneInput("p2", { write: () => {} });

    const result = await registry.execute(
      "pane.write",
      {
        workspace: "ws-1",
        agent: "p2",
        text: "dictated",
        mode: "type",
        focusInput: true,
      },
      HOST,
    );
    off();

    expect(result.ok).toBe(true);
    expect(activatePane).toHaveBeenCalledWith("ws-1", "p2");
  });

  it("explicit mode:'paste' routes through the paste channel (acceptance)", async () => {
    const { registry } = setup([twoPanes()]);
    const pasted: string[] = [];
    const written: string[] = [];
    const off = registerPaneInput("p2", {
      write: (t) => written.push(t),
      paste: (t) => pasted.push(t),
    });
    const result = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello", mode: "paste" },
      HOST,
    );
    off();
    expect(result.ok).toBe(true);
    expect(pasted).toEqual(["hello"]);
    expect(written).toEqual([]);
  });

  it("rejects an unknown mode value instead of silently falling back to paste", async () => {
    const { registry } = setup([twoPanes()]);
    // No live pane needed: mode validation is the first statement in run(), so
    // a bad value throws before any pane is resolved.
    const bad = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello", mode: "raw" },
      HOST,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("unknown pane.write mode");
  });

  it("write without a live session fails; without a selection it refuses", async () => {
    const { registry } = setup([twoPanes()]);
    const dead = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello" },
      HOST,
    );
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.error.message).toBe("the pane has no live session");

    const unaddressed = await registry.execute("pane.write", { text: "hi" }, HOST);
    expect(unaddressed.ok).toBe(false);
    if (!unaddressed.ok)
      expect(unaddressed.error.message).toBe('no agent selected in workspace "web"');
  });

  it("a live TYPE-only pane refuses paste with a distinct message", async () => {
    const { registry } = setup([twoPanes()]);
    // TYPE-only: live entry (paneInputReady true) but no paste channel. A live
    // TerminalPane always registers both, so this models a future TYPE-only
    // registrant — the error must name the real cause, not "no live session".
    const off = registerPaneInput("p2", { write: () => {} });
    const result = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello" },
      HOST,
    );
    off();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toBe("the pane has no paste channel");
  });
});

describe("settings.open", () => {
  it("opens a plugin's own section, and the first section for anyone else", async () => {
    const { registry, openSettings } = setup([workspace({})]);
    await registry.execute("settings.open", {}, {
      kind: "plugin",
      pluginId: "keepdeck.voice",
    });
    expect(openSettings).toHaveBeenCalledWith("plugin:keepdeck.voice");

    await registry.execute("settings.open", {}, HOST);
    expect(openSettings).toHaveBeenLastCalledWith(null);
  });

  it("reports a refusal instead of claiming it opened over another dialog", async () => {
    // A command arrives with no button to have been disabled, so the host
    // gate is the only thing standing between it and a stacked dialog. When
    // it refuses, saying `{opened: true}` would tell a plugin a surface is up
    // that is not — and stacking is what gives one Escape two layers to peel.
    const { registry, openSettings } = setup([workspace({})]);
    openSettings.mockReturnValue(false);

    const result = await registry.execute("settings.open", {}, HOST);

    expect(result.ok).toBe(false);
    expect(openSettings).toHaveBeenCalledOnce();
  });
});

describe("usage.open", () => {
  it("opens the global usage statistics surface", async () => {
    const { registry, openUsage } = setup([workspace({})]);
    const result = await registry.execute("usage.open", {}, HOST);

    expect(result).toEqual({ ok: true, value: { opened: true } });
    expect(openUsage).toHaveBeenCalledOnce();
  });

  it("reports a refusal instead of claiming it opened over another dialog", async () => {
    const { registry, openUsage } = setup([workspace({})]);
    openUsage.mockReturnValue(false);

    const result = await registry.execute("usage.open", {}, HOST);

    expect(result.ok).toBe(false);
  });
});

describe("deliverTask", () => {
  it("gives up when the pane's writer never appears", async () => {
    const delivered = await deliverTask("ghost-pane", "task", async () => {});
    expect(delivered).toBe(false);
  });
});
