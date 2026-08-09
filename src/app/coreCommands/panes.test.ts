// FIRST, before anything that reaches the mocked IPC — see testSupport.
import { HOST, resetCoreCommandTestState, setup, workspace } from "./testSupport";
import { beforeEach, describe, expect, it } from "vitest";
import { registerPaneInput } from "../paneInput";

beforeEach(() => {
  resetCoreCommandTestState();
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

  it("refuses a blank agent instead of focusing whatever was selected", async () => {
    // `agent` is required here, unlike every other command in this set where the
    // selected pane is the default. Read with the OPTIONAL reader, a blank one
    // meant "omitted" and resolved to the pane already focused — so the caller
    // was told its focus request succeeded, naming a pane it never asked for.
    const { registry, activatePane } = setup([twoPanes()]);

    const blank = await registry.execute("agent.focus", { agent: "" }, HOST);

    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.message).toBe('argument "agent" must not be blank');
    expect(activatePane).not.toHaveBeenCalled();
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

  it("sends whitespace-only text through untouched", async () => {
    // The counterpart to the blank refusals above, and why blankness cannot be
    // one rule at the registry: `text` is CONTENT, so a lone space is exactly
    // what the caller meant and must arrive as sent — indentation in a heredoc,
    // a space to dismiss a prompt. Trimming it or refusing it as blank would
    // silently edit what an agent wrote.
    const { registry } = setup([twoPanes()]);
    const pasted: string[] = [];
    const off = registerPaneInput("p2", {
      write: () => true,
      paste: (t) => pasted.push(t),
    });
    const result = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "  " },
      HOST,
    );
    off();
    expect(result.ok).toBe(true);
    expect(pasted).toEqual(["  "]);
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
