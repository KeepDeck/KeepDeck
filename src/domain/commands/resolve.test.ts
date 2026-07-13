import { describe, expect, it } from "vitest";
import type { AgentInfo } from "../agents";
import type { Workspace } from "../deck";
import { resolvePaneRef, resolveWorkspaceRef } from "./resolve";

const AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude", command: "claude", installed: true, path: "/c" },
  { id: "codex", label: "Codex", command: "codex", installed: true, path: "/x" },
];

const ws = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  name: "KeepDeck",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  ...over,
});

describe("resolveWorkspaceRef", () => {
  const workspaces = [
    ws({ id: "ws-1", name: "KeepDeck" }),
    ws({ id: "ws-2", name: "Website" }),
    ws({ id: "ws-3", name: "web" }),
    ws({ id: "ws-4", name: "Web" }),
  ];

  it("matches an exact id first", () => {
    const r = resolveWorkspaceRef(workspaces, "ws-2");
    expect(r).toEqual({ ok: true, value: workspaces[1] });
  });

  it("matches a unique name case-insensitively", () => {
    const r = resolveWorkspaceRef(workspaces, "keepdeck");
    expect(r.ok && r.value.id).toBe("ws-1");
  });

  it("refuses an ambiguous name instead of guessing", () => {
    const r = resolveWorkspaceRef(workspaces, "WEB");
    expect(r).toEqual({ ok: false, message: 'workspace name "WEB" is ambiguous' });
  });

  it("refuses an unknown reference", () => {
    const r = resolveWorkspaceRef(workspaces, "nope");
    expect(r).toEqual({ ok: false, message: 'no workspace "nope"' });
  });
});

describe("resolvePaneRef", () => {
  const workspace = ws({
    panes: [
      { id: "p1", agentType: "claude" },
      { id: "p2", agentType: "claude", name: "reviewer" },
      { id: "p3", agentType: "codex" },
    ],
  });

  it("matches an exact pane id first", () => {
    const r = resolvePaneRef(workspace, AGENTS, "p3");
    expect(r.ok && r.value.id).toBe("p3");
  });

  it("matches the display title the header shows", () => {
    const r = resolvePaneRef(workspace, AGENTS, "claude 1");
    expect(r.ok && r.value.id).toBe("p1");
  });

  it("matches a user-given pane name", () => {
    const r = resolvePaneRef(workspace, AGENTS, "Reviewer");
    expect(r.ok && r.value.id).toBe("p2");
  });

  it("refuses unknown and reports the workspace", () => {
    const r = resolvePaneRef(workspace, AGENTS, "ghost");
    expect(r).toEqual({
      ok: false,
      message: 'no agent "ghost" in workspace "KeepDeck"',
    });
  });

  it("refuses an ambiguous reference", () => {
    const twin = ws({
      panes: [
        { id: "a", agentType: "claude", name: "dup" },
        { id: "b", agentType: "codex", name: "dup" },
      ],
    });
    const r = resolvePaneRef(twin, AGENTS, "dup");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("ambiguous");
  });
});
