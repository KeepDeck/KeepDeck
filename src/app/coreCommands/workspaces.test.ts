// FIRST, before anything that reaches the mocked IPC — see testSupport.
import { HOST, resetCoreCommandTestState, setup, workspace } from "./testSupport";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  resetCoreCommandTestState();
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

  it("refuses a blank workspace instead of reporting a switch that never happened", async () => {
    // The registry accepts "" for a required string — it validates presence and
    // type, and blankness depends on what the argument IS. Read with the
    // OPTIONAL reader, a blank one became "omitted", which resolves to the
    // ACTIVE workspace: the caller got ok and a workspaceId for the workspace it
    // was already in, and nothing said its argument was junk.
    const { registry, deck } = setup([
      workspace({}),
      workspace({ id: "ws-2", name: "site" }),
    ]);

    const blank = await registry.execute("workspace.switch", { workspace: "  " }, HOST);

    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.message).toBe('argument "workspace" must not be blank');
    expect(deck.selectWorkspace).not.toHaveBeenCalled();
  });
});
