import { describe, expect, it } from "vitest";
import { MAX_PANES } from "../layout";
import {
  appendPane,
  paneDisplayTitle,
  paneFrozenTitle,
  removePane,
  resolveFocus,
  type Pane,
} from ".";

const seed = (n: number): Pane[] =>
  Array.from({ length: n }, (_, i) => ({ id: `pane-${i + 1}`, agentType: "claude" }));

describe("appendPane", () => {
  it("appends an already-formed pane (worktree fields preserved)", () => {
    const pane = { id: "pane-2", agentType: "claude", cwd: "/wt/2", branch: "kd/ws/2" };
    expect(appendPane(seed(1), pane)).toEqual([{ id: "pane-1", agentType: "claude" }, pane]);
  });

  it("appends past MAX_PANES — the cap is the team's, enforced where a pane joins one", () => {
    const full = seed(MAX_PANES);
    expect(appendPane(full, { id: "overflow", agentType: "claude" })).toHaveLength(MAX_PANES + 1);
  });
});


describe("removePane", () => {
  it("removes by id and keeps the rest", () => {
    expect(removePane(seed(3), "pane-2")).toEqual([
      { id: "pane-1", agentType: "claude" },
      { id: "pane-3", agentType: "claude" },
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const panes = seed(2);
    expect(removePane(panes, "pane-9")).toEqual(panes);
  });
});

describe("resolveFocus", () => {
  it("returns the focused pane id when it's one of several panes", () => {
    expect(resolveFocus(seed(3), ["pane-2"])).toBe("pane-2");
  });

  it("answers the spotlight on this grid among other grids' ones", () => {
    expect(resolveFocus(seed(3), ["other-1", "pane-3", "other-2"])).toBe("pane-3");
    expect(resolveFocus(seed(3), ["other-1"])).toBeNull();
  });

  it("returns null for a solo pane — maximize is a no-op ([U1])", () => {
    expect(resolveFocus(seed(1), ["pane-1"])).toBeNull();
  });

  it("returns null when the focused id no longer matches any pane", () => {
    // The maximized pane was closed, leaving others behind.
    expect(resolveFocus(seed(3), ["pane-9"])).toBeNull();
  });

  it("returns null when nothing is focused", () => {
    expect(resolveFocus(seed(3), undefined)).toBeNull();
  });

  it("returns null for an empty workspace", () => {
    expect(resolveFocus([], ["pane-1"])).toBeNull();
  });
});

describe("paneDisplayTitle", () => {
  const agents = [
    {
      id: "claude" as const,
      label: "Claude Code",
      command: "claude",
      features: [],
      installed: true,
      path: null,
    },
  ];

  it("prefers the manual name, then the auto title, then the derived label", () => {
    const pane: Pane = { id: "pane-1", agentType: "claude" };
    expect(
      paneDisplayTitle({ ...pane, name: "api", autoTitle: "vim" }, 0, agents),
    ).toBe("api");
    expect(paneDisplayTitle({ ...pane, autoTitle: "vim" }, 0, agents)).toBe(
      "vim",
    );
    expect(paneDisplayTitle(pane, 2, agents)).toBe("Claude Code 3");
  });

  describe("title glyphs", () => {
    const decorated = [
      { id: "glyphs", label: "Glyphs", titleGlyphs: ["✶", "✳"] },
      { id: "plain", label: "Plain" },
    ];
    const title = (agentType: string, autoTitle: string) =>
      paneDisplayTitle({ id: "pane-1", agentType, autoTitle }, 0, decorated);

    it("strips a glyph only for the agent that declares it, followed by whitespace", () => {
      expect(title("glyphs", "✶ Glyphs")).toBe("Glyphs");
      expect(title("glyphs", "✳ thinking")).toBe("thinking");
      // Another agent's leading glyph is its own title.
      expect(title("plain", "✶ deliberate")).toBe("✶ deliberate");
      // A glyph that is part of the word is not decoration.
      expect(title("glyphs", "✶deliberate")).toBe("✶deliberate");
      // A glyph it does not declare stays.
      expect(title("glyphs", "✦ other")).toBe("✦ other");
    });

    it("falls back past a title that was only the decoration", () => {
      expect(title("glyphs", "✶  ")).toBe("Glyphs 1");
    });

    it("freezes the same cleaned title the header shows, and nothing positional", () => {
      const pane = { id: "pane-1", agentType: "glyphs", autoTitle: "✶ sealed" };
      expect(paneFrozenTitle(pane, decorated)).toBe("sealed");
      expect(paneFrozenTitle({ id: "pane-1", agentType: "glyphs" }, decorated)).toBeUndefined();
      expect(paneFrozenTitle({ ...pane, name: "named" }, decorated)).toBe("named");
    });
  });

  it("falls back to the raw agent id while the catalog has no entry", () => {
    expect(
      paneDisplayTitle({ id: "pane-1", agentType: "codex" }, 0, agents),
    ).toBe("codex 1");
  });
});
