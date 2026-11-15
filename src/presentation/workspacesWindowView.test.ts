import { describe, expect, it } from "vitest";
import type { Workspace, WorkspaceArchived } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { workspacesWindowView, type WorkspacesWindowInput } from "./workspacesWindowView";

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const HOURS = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const ws = (id: string, name: string, cwd: string, archived?: WorkspaceArchived, over: Partial<Workspace> = {}): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name,
  cwd,
  worktreeBaseDir: null,
  panes: [],
  ...(archived && { archived }),
  ...over,
});
const DECK = [
  ws("ws-1", "KeepDeck", "/Users/me/keepdeck", undefined, {
    teams: [{ id: "t1", name: "api" }],
    panes: [
      { id: "p1", agentType: "claude" },
      { id: "p2", agentType: "claude" },
    ],
  }),
  ws("ws-2", "Site", "/Users/me/site"),
  ws("ws-3", "Old blog", "/Users/me/blog", { at: HOURS(50), phase: "archived" }),
  ws("ws-4", "Spike", "/tmp/spike", { at: HOURS(2), phase: "archived" }),
];
const view = (over: Partial<WorkspacesWindowInput> = {}) =>
  workspacesWindowView({ workspaces: DECK, activeId: "ws-1", query: "", focus: null, now: NOW, ...over });
const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

describe("workspacesWindowView — the list", () => {
  it("lists the strip's workspaces, then the archived ones newest first, counted", () => {
    const v = view();
    expect(v.inStrip.label).toBe("In the strip · 2");
    expect(ids(v.inStrip.rows)).toEqual(["ws-1", "ws-2"]);
    expect(v.archived.label).toBe("Archived · 2");
    expect(ids(v.archived.rows)).toEqual(["ws-4", "ws-3"]);
  });

  it("says which one is on screen, and when each archive was put away", () => {
    const v = view();
    expect(v.inStrip.rows.map((row) => row.meta)).toEqual(["on screen", null]);
    expect(v.archived.rows.map((row) => row.meta)).toEqual(["2h ago", "2d ago"]);
  });

  it("finds a workspace by its name or its folder, whatever the case", () => {
    expect(ids(view({ query: "BLOG" }).archived.rows)).toEqual(["ws-3"]);
    expect(ids(view({ query: "/tmp" }).archived.rows)).toEqual(["ws-4"]);
    expect(ids(view({ query: "  site " }).inStrip.rows)).toEqual(["ws-2"]);
    const none = view({ query: "nothing like it" });
    expect(none.noMatch).toBe(true);
    expect(none.inStrip.label).toBe("In the strip · 0");
  });

  it("opens on what was picked, else on the workspace on screen, and marks its row", () => {
    expect(view().page?.id).toBe("ws-1");
    expect(view({ focus: "ws-3" }).page?.id).toBe("ws-3");
    expect(view({ focus: "ws-3" }).archived.rows.find((row) => row.id === "ws-3")?.selected).toBe(true);
    // Every workspace archived: nobody on screen, the first one opens.
    expect(view({ activeId: "" }).page?.id).toBe("ws-1");
    expect(workspacesWindowView({ workspaces: [], activeId: "", query: "", focus: null, now: NOW }).page).toBeNull();
  });
});

describe("workspacesWindowView — the page", () => {
  it("names a workspace in use and offers to archive or close it", () => {
    const page = view().page;
    expect(page).toMatchObject({
      name: "KeepDeck",
      initials: "KD",
      cwd: "/Users/me/keepdeck",
      facts: "1 team · 2 agents",
      state: { kind: "in-use" },
      acts: { restore: false, archive: true, close: { disabled: false } },
    });
  });

  it("says of an archive that its agents are suspended and the rest kept — and that Restore wakes nobody", () => {
    const page = view({ focus: "ws-3" }).page;
    expect(page?.state).toEqual({
      kind: "archived",
      banner: "Archived 2d ago. Its agents are suspended; teams, worktrees, board and artifacts are kept.",
      owed: null,
    });
    expect(page?.acts).toEqual({ restore: true, archive: false, close: { disabled: false } });
  });

  it("says what an archive still owes", () => {
    const owing = ws("ws-5", "Owing", "/o", { at: HOURS(1), phase: "archived", warnings: { reaps: ["p1"], disarm: true } });
    const page = workspacesWindowView({ workspaces: [owing], activeId: "", query: "", focus: "ws-5", now: NOW }).page;
    expect(page?.state).toMatchObject({
      owed: "1 agent did not stop cleanly; KeepDeck's files could not be taken out of its folders — tried again on the next launch.",
    });
  });

  it("gives a page its own fields: editable in use, kept as they are when archived", () => {
    expect(view().page?.fields).toEqual({
      editable: true,
      name: "KeepDeck",
      mark: "",
      cwd: { path: "/Users/me/keepdeck", locked: true },
      worktreeBaseDir: null,
    });
    expect(view({ focus: "ws-2" }).page?.fields.cwd.locked).toBe(false);
    expect(view({ focus: "ws-3" }).page?.fields.editable).toBe(false);
  });

  it("will not close one still being archived, and says why", () => {
    const busy = ws("ws-6", "Busy", "/b", { at: HOURS(0), phase: "archiving" });
    const page = workspacesWindowView({ workspaces: [busy], activeId: "", query: "", focus: null, now: NOW }).page;
    expect(page?.state.kind).toBe("archiving");
    expect(page?.acts.close).toEqual({ disabled: true, refusal: "It can be closed once the archive has stopped its agents." });
    expect(page?.acts.restore).toBe(true);
  });
});
