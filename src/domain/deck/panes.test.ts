import { describe, expect, it } from "vitest";
import { MAX_PANES } from "./layout";
import {
  appendPane,
  idleWakesAutomatically,
  makePanes,
  makeProvisioningPanes,
  paneCanSuspend,
  paneDisplayTitle,
  paneIsRemoteFresh,
  paneIsStopped,
  paneOnScreen,
  paneSuspendBlock,
  paneResumeSessionId,
  paneWakesAutomatically,
  partitionPanes,
  removePane,
  resolveFocus,
  type Pane,
} from "./panes";

const seed = (n: number): Pane[] =>
  Array.from({ length: n }, (_, i) => ({ id: `pane-${i + 1}` }));

describe("paneIsRemoteFresh", () => {
  it("true only for a pane with a non-empty remote endpoint", () => {
    expect(paneIsRemoteFresh({ id: "p", remoteEndpoint: "ws://vps:4500" })).toBe(true);
    // Absent endpoint → local.
    expect(paneIsRemoteFresh({ id: "p" })).toBe(false);
    // Truthy, not `!== undefined`: an empty string is a non-remote degenerate
    // case (hand-edit only — the dialog never sets "") so lifecycle + plan
    // builder agree it's local.
    expect(paneIsRemoteFresh({ id: "p", remoteEndpoint: "" })).toBe(false);
  });
});

describe("paneCanSuspend", () => {
  it("true for a running pane, and for one whose process already exited", () => {
    // Exit is runtime state the durable model doesn't carry, so an exited pane
    // is indistinguishable here — deliberately: parking a dead agent is
    // meaningful, its card just becomes the honest stopped one.
    expect(paneCanSuspend({ id: "p" })).toBe(true);
    expect(paneCanSuspend({ id: "p", session: { id: "s", boundAt: "t" } })).toBe(
      true,
    );
  });

  it("false only for a pane already STAYING down", () => {
    expect(paneCanSuspend({ id: "p", idle: { reason: "parked" } })).toBe(false);
    expect(
      paneCanSuspend({ id: "p", idle: { reason: "suspended", at: "t" } }),
    ).toBe(false);
  });

  it("true for a pane on its way up — stopping it cancels the wake", () => {
    // Panes in a workspace the user isn't looking at stay `waking` until it is
    // activated; refusing them made those agents impossible to park.
    expect(
      paneCanSuspend({ id: "p", idle: { reason: "waking", origin: "restore" } }),
    ).toBe(true);
    expect(
      paneCanSuspend({ id: "p", idle: { reason: "waking", origin: "manual" } }),
    ).toBe(true);
  });

  it("names the reason it refuses, so every surface says the same thing", () => {
    expect(paneSuspendBlock({ id: "p" })).toBeNull();
    expect(paneSuspendBlock({ id: "p", idle: { reason: "parked" } })).toBe("idle");
    expect(
      paneSuspendBlock({
        id: "p",
        provisioning: { repo: "/r", workspace: "w", index: 1 },
      }),
    ).toBe("provisioning");
    expect(
      paneSuspendBlock({ id: "p", remoteEndpoint: "ws://vps:4500" }),
    ).toBe("remote");
    // Precedence matters: it decides which sentence the user reads.
    expect(
      paneSuspendBlock({
        id: "p",
        idle: { reason: "parked" },
        remoteEndpoint: "ws://vps:4500",
      }),
    ).toBe("idle");
  });

  it("false while a worktree create is in flight — no process to stop", () => {
    expect(
      paneCanSuspend({
        id: "p",
        provisioning: { repo: "/r", workspace: "w", index: 1 },
      }),
    ).toBe(false);
  });

  it("false for a REMOTE pane — its conversation lives on the server", () => {
    expect(paneCanSuspend({ id: "p", remoteEndpoint: "ws://vps:4500" })).toBe(
      false,
    );
  });
});

describe("idleWakesAutomatically / paneWakesAutomatically", () => {
  it("only a pane on its way up wakes by itself", () => {
    expect(idleWakesAutomatically({ reason: "waking", origin: "restore" })).toBe(true);
    expect(idleWakesAutomatically({ reason: "waking", origin: "manual" })).toBe(true);
    expect(idleWakesAutomatically({ reason: "parked" })).toBe(false);
    expect(idleWakesAutomatically({ reason: "suspended", at: "t" })).toBe(false);
  });

  it("a live pane is not the sweep's business", () => {
    expect(paneWakesAutomatically({ id: "p" })).toBe(false);
    expect(paneWakesAutomatically({ id: "p", idle: { reason: "waking", origin: "restore" } })).toBe(
      true,
    );
    expect(
      paneWakesAutomatically({ id: "p", idle: { reason: "suspended", at: "t" } }),
    ).toBe(false);
  });
});

describe("paneIsStopped", () => {
  it("true only when nothing is bringing the pane back on its own", () => {
    expect(paneIsStopped({ id: "p" })).toBe(false); // running
    expect(paneIsStopped({ id: "p", idle: { reason: "waking", origin: "restore" } })).toBe(false);
    expect(paneIsStopped({ id: "p", idle: { reason: "waking", origin: "manual" } })).toBe(false);
    expect(paneIsStopped({ id: "p", idle: { reason: "parked" } })).toBe(true);
    expect(
      paneIsStopped({ id: "p", idle: { reason: "suspended", at: "t" } }),
    ).toBe(true);
  });
});

describe("paneResumeSessionId", () => {
  it("is the binding, or null when the pane would start fresh", () => {
    expect(
      paneResumeSessionId({ id: "p", session: { id: "s-1", boundAt: "t" } }),
    ).toBe("s-1");
    expect(paneResumeSessionId({ id: "p" })).toBeNull();
  });

  it("is null for a remote pane even when a stale binding clings to it", () => {
    // Resuming that id locally would be a different conversation from the one
    // living on the server.
    expect(
      paneResumeSessionId({
        id: "p",
        remoteEndpoint: "ws://vps:4500",
        session: { id: "stale", boundAt: "t" },
      }),
    ).toBeNull();
  });
});

describe("appendPane", () => {
  it("appends an already-formed pane (worktree fields preserved)", () => {
    const pane = { id: "pane-2", cwd: "/wt/2", branch: "kd/ws/2" };
    expect(appendPane(seed(1), pane)).toEqual([{ id: "pane-1" }, pane]);
  });

  it("is a no-op at MAX_PANES (returns the same array)", () => {
    const full = seed(MAX_PANES);
    expect(appendPane(full, { id: "overflow" })).toBe(full);
  });
});

describe("makePanes", () => {
  it("builds count panes from startSeq, all of the given type", () => {
    expect(makePanes(3, 2, "claude")).toEqual([
      { id: "pane-3", agentType: "claude" },
      { id: "pane-4", agentType: "claude" },
    ]);
  });

  it("clamps to MAX_PANES and never goes negative", () => {
    expect(makePanes(1, MAX_PANES + 5, "claude")).toHaveLength(MAX_PANES);
    expect(makePanes(1, 0, "claude")).toEqual([]);
    expect(makePanes(1, -2, "claude")).toEqual([]);
  });
});

describe("makeProvisioningPanes", () => {
  it("builds panes carrying their per-index create intent", () => {
    expect(
      makeProvisioningPanes(5, 2, "codex", {
        cwd: "/repo",
        baseDir: "/wt",
        name: "deck",
      }),
    ).toEqual([
      {
        id: "pane-5",
        agentType: "codex",
        provisioning: {
          repo: "/repo",
          baseDir: "/wt",
          runsSetup: true,
          workspace: "deck",
          index: 1,
        },
      },
      {
        id: "pane-6",
        agentType: "codex",
        provisioning: {
          repo: "/repo",
          baseDir: "/wt",
          runsSetup: true,
          workspace: "deck",
          index: 2,
        },
      },
    ]);
  });

  it("clamps to MAX_PANES like makePanes", () => {
    expect(
      makeProvisioningPanes(1, MAX_PANES + 3, "claude", {
        cwd: "/repo",
        baseDir: "/wt",
        name: "ws",
      }),
    ).toHaveLength(MAX_PANES);
  });
});

describe("removePane", () => {
  it("removes by id and keeps the rest", () => {
    expect(removePane(seed(3), "pane-2")).toEqual([
      { id: "pane-1" },
      { id: "pane-3" },
    ]);
  });

  it("is a no-op for an unknown id", () => {
    const panes = seed(2);
    expect(removePane(panes, "pane-9")).toEqual(panes);
  });
});

describe("resolveFocus", () => {
  it("returns the focused pane id when it's one of several panes", () => {
    expect(resolveFocus(seed(3), "pane-2")).toBe("pane-2");
  });

  it("returns null for a solo pane — maximize is a no-op ([U1])", () => {
    expect(resolveFocus(seed(1), "pane-1")).toBeNull();
  });

  it("returns null when the focused id no longer matches any pane", () => {
    // The maximized pane was closed, leaving others behind.
    expect(resolveFocus(seed(3), "pane-9")).toBeNull();
  });

  it("returns null when nothing is focused", () => {
    expect(resolveFocus(seed(3), undefined)).toBeNull();
  });

  it("returns null for an empty workspace", () => {
    expect(resolveFocus([], "pane-1")).toBeNull();
  });
});

describe("paneDisplayTitle", () => {
  const agents = [
    {
      id: "claude" as const,
      label: "Claude Code",
      command: "claude",
      supportsYolo: false,
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

  it("strips decorative Claude title glyphs without changing the stored auto title", () => {
    expect(
      paneDisplayTitle({ id: "pane-1", agentType: "claude", autoTitle: "✶ Claude Code" }, 0, agents),
    ).toBe("Claude Code");
    expect(
      paneDisplayTitle({ id: "pane-1", agentType: "claude", autoTitle: "✳ thinking" }, 0, agents),
    ).toBe("thinking");
  });

  it("falls back to the raw agent id while the catalog has no entry", () => {
    expect(
      paneDisplayTitle({ id: "pane-1", agentType: "codex" }, 0, agents),
    ).toBe("codex 1");
  });

  it("defaults a type-less pane to claude", () => {
    expect(paneDisplayTitle({ id: "pane-1" }, 1, agents)).toBe("Claude Code 2");
  });
});

describe("partitionPanes", () => {
  it("returns the SAME array as live (and empty minimized) when nothing is minimized", () => {
    const panes = seed(3);
    const both = partitionPanes(panes, undefined);
    expect(both.live).toBe(panes); // stable ref for memoization
    expect(both.minimized).toEqual([]);
    expect(partitionPanes(panes, []).live).toBe(panes);
  });

  it("splits by the minimized set, preserving pane order in each group", () => {
    const panes = seed(4); // pane-1..pane-4
    const { live, minimized } = partitionPanes(panes, ["pane-3", "pane-1"]);
    expect(live.map((p) => p.id)).toEqual(["pane-2", "pane-4"]);
    expect(minimized.map((p) => p.id)).toEqual(["pane-1", "pane-3"]);
  });

  it("ignores minimized ids that no longer match a pane (self-heals)", () => {
    const panes = seed(2);
    const { live, minimized } = partitionPanes(panes, ["pane-2", "pane-99"]);
    expect(live.map((p) => p.id)).toEqual(["pane-1"]);
    expect(minimized.map((p) => p.id)).toEqual(["pane-2"]);
  });
});

describe("paneOnScreen", () => {
  const panes = seed(3); // pane-1..3

  it("grid, plainly tiled: every live pane is on screen", () => {
    expect(paneOnScreen(panes, undefined, "grid", true, "pane-2")).toBe(true);
  });

  it("grid: a minimized pane is off screen — but only while minimize is in force", () => {
    const view = { minimized: ["pane-2"] };
    expect(paneOnScreen(panes, view, "grid", true, "pane-2")).toBe(false);
    expect(paneOnScreen(panes, view, "grid", true, "pane-1")).toBe(true);
    // minimizeStyle "none" / list mode ignore the stored minimized set,
    // exactly as DeckStage renders it.
    expect(paneOnScreen(panes, view, "grid", false, "pane-2")).toBe(true);
  });

  it("grid with a maximize: only the maximized pane is on screen", () => {
    const view = { focus: "pane-1" };
    expect(paneOnScreen(panes, view, "grid", true, "pane-1")).toBe(true);
    expect(paneOnScreen(panes, view, "grid", true, "pane-2")).toBe(false);
  });

  it("grid: a STALE maximize (its pane gone) resolves to none, like resolveFocus", () => {
    const view = { focus: "pane-gone" };
    expect(paneOnScreen(panes, view, "grid", true, "pane-2")).toBe(true);
  });

  it("grid: a maximize on a solo pane is a no-op — the lone tile is on screen", () => {
    expect(paneOnScreen(seed(1), { focus: "pane-1" }, "grid", true, "pane-1")).toBe(
      true,
    );
  });

  it("list: only the expanded pane is on screen; empty select expands the first", () => {
    expect(paneOnScreen(panes, { select: "pane-2" }, "list", false, "pane-2")).toBe(
      true,
    );
    expect(paneOnScreen(panes, { select: "pane-2" }, "list", false, "pane-1")).toBe(
      false,
    );
    // DeckStage's default: view?.select ?? panes[0]
    expect(paneOnScreen(panes, undefined, "list", false, "pane-1")).toBe(true);
    expect(paneOnScreen(panes, undefined, "list", false, "pane-2")).toBe(false);
  });

  it("an unknown pane is never on screen", () => {
    expect(paneOnScreen(panes, undefined, "grid", true, "pane-99")).toBe(false);
    expect(paneOnScreen([], undefined, "list", false, "pane-1")).toBe(false);
  });
});
