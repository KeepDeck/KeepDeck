import { describe, expect, it } from "vitest";
import type { GitStatus, WorkspaceSnapshot } from "@keepdeck/plugin-api";
import { rootFacts, withHead, type RootFact } from "./roots";

const snapshot = (over: Partial<WorkspaceSnapshot>): WorkspaceSnapshot => ({
  id: "ws-1",
  instance: "i-1",
  name: "app",
  cwd: "/repo",
  panes: [],
  teams: [],
  ...over,
});

describe("rootFacts", () => {
  it("is one row per directory, named by its team, the workspace folder last", () => {
    const facts = rootFacts(
      snapshot({
        teams: [
          { id: "team-1", name: "api", cwd: "/wt/api", branch: "kd/api/1" },
          { id: "team-2", name: "web", cwd: "/wt/web", branch: "kd/web/1" },
        ],
        panes: [
          { id: "p1", name: "lead", cwd: "/wt/api", branch: "kd/api/1", agentType: "claude", team: "team-1" },
          { id: "p2", name: "impl", cwd: "/wt/api", branch: "kd/api/1", agentType: "claude", team: "team-1" },
          { id: "p3", name: "lead", cwd: "/wt/web", branch: "kd/web/1", agentType: "codex", team: "team-2" },
          { id: "p4", name: "shell", agentType: "unknown" },
        ],
      }),
    );
    expect(facts).toEqual([
      { cwd: "/wt/api", team: { id: "team-1", name: "api" }, branch: "kd/api/1", agents: 2, workspace: false },
      { cwd: "/wt/web", team: { id: "team-2", name: "web" }, branch: "kd/web/1", agents: 1, workspace: false },
      { cwd: "/repo", agents: 1, workspace: true },
    ]);
  });

  it("lists a team's directory only while a pane runs there", () => {
    // The host builds the plugin's reach from the panes; a folder nobody
    // runs in would be offered and then refused. Whether an empty team's
    // tree should be readable is the host's decision.
    const facts = rootFacts(
      snapshot({
        teams: [
          { id: "team-1", name: "empty", cwd: "/wt/empty", branch: "kd/e" },
          { id: "team-2", name: "making", branch: "kd/m" },
        ],
        panes: [{ id: "p1", name: "x", agentType: "claude", team: "team-2" }],
      }),
    );
    expect(facts).toEqual([{ cwd: "/repo", agents: 1, workspace: true }]);
  });

  it("a pane on the workspace root counts under the workspace folder", () => {
    const facts = rootFacts(
      snapshot({
        teams: [{ id: "team-1", name: "root", cwd: "/repo", branch: "main" }],
        panes: [{ id: "p1", name: "x", cwd: "/repo", branch: "main", agentType: "claude", team: "team-1" }],
      }),
    );
    expect(facts).toEqual([{ cwd: "/repo", agents: 1, workspace: true }]);
  });

  it("a directory no team claims still gets a row, by its branch alone", () => {
    const facts = rootFacts(
      snapshot({
        panes: [{ id: "p1", name: "x", cwd: "/wt/lone", branch: "kd/lone", agentType: "claude" }],
      }),
    );
    expect(facts[0]).toEqual({ cwd: "/wt/lone", branch: "kd/lone", agents: 1, workspace: false });
  });
});

describe("withHead", () => {
  const status = (over: Partial<GitStatus>): GitStatus => ({
    branch: "main",
    detached: false,
    oid: "abc1234def",
    upstream: null,
    ahead: null,
    behind: null,
    entries: [],
    ...over,
  });
  const facts: RootFact[] = [
    { cwd: "/wt/api", team: { id: "team-1", name: "api" }, agents: 1, workspace: false },
    { cwd: "/wt/web", team: { id: "team-2", name: "web" }, branch: "kd/web/1", agents: 1, workspace: false },
    { cwd: "/repo", agents: 1, workspace: true },
  ];

  it("names a detached tree by its commit when the host had no branch for it", () => {
    const named = withHead(facts, "/wt/api", status({ branch: null, detached: true, oid: "0123456789abcdef" }));
    expect(named[0].branch).toBe("0123456 (detached)");
    // Only the root the status was read for; the others are not its business.
    expect(named[1]).toBe(facts[1]);
    expect(named[2]).toBe(facts[2]);
  });

  it("keeps the branch the host named, and the workspace folder's bare line", () => {
    const detached = status({ branch: null, detached: true, oid: "0123456789abcdef" });
    expect(withHead(facts, "/wt/web", detached)[1].branch).toBe("kd/web/1");
    expect(withHead(facts, "/repo", detached)[2]).toBe(facts[2]);
  });

  it("does nothing before the status has loaded", () => {
    expect(withHead(facts, "/wt/api", null)).toBe(facts);
  });
});
