import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../../workspaceInstance";
import type { Workspace } from "../workspaces";
import type { Team } from "./model";
import { claimPath, directoriesStillHeld, teamOccupyingPath } from "./claims";

/** Two workspaces opened on one repository: each has a team on the root, the
 * two share a worktree (spelled with and without a trailing slash), one has a
 * create still heading for its directory. */
const attached = (id: string, cwd: string): Team => ({ id, name: id, location: { kind: "attached", cwd } });
const creating = (id: string, path: string): Team => ({
  id,
  name: id,
  location: { kind: "provisioning", intent: { repo: "/repo", path, branch: `kd/${id}`, index: 1 } },
});
const ws = (id: string, teams: Team[]): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  teams,
});
const A = ws("ws-a", [attached("ta1", "/repo"), attached("ta2", "/wt/a2"), creating("ta3", "/wt/a3")]);
const B = ws("ws-b", [attached("tb1", "/repo"), attached("tb2", "/wt/a2/"), attached("tb3", "/wt/b3")]);
const DECK = [A, B];

const holder = (claim: ReturnType<typeof claimPath>) =>
  claim.kind === "free" ? "free" : `${claim.ws.id}/${claim.team.id}${claim.creating ? " creating" : ""}`;

describe("who holds a directory — one answer per question", () => {
  it("claimPath: the asking workspace's own team first; its root is its own", () => {
    expect(holder(claimPath(DECK, A, "/repo"))).toBe("ws-a/ta1");
    expect(holder(claimPath(DECK, B, "/repo/"))).toBe("ws-b/tb1");
    expect(holder(claimPath(DECK, B, "/wt/a2"))).toBe("ws-b/tb2");
    expect(holder(claimPath(DECK, A, "/wt/a2/"))).toBe("ws-a/ta2");
    expect(holder(claimPath(DECK, A, " /wt/b3 "))).toBe("ws-b/tb3");
    expect(holder(claimPath(DECK, B, "/wt/a3"))).toBe("ws-a/ta3 creating");
    expect(holder(claimPath(DECK, A, "/nowhere"))).toBe("free");
    expect(holder(claimPath(DECK, A, ""))).toBe("free");
  });

  it("claimPath: a root another workspace's team sits on is not a claim here", () => {
    const empty = ws("ws-c", []);
    expect(holder(claimPath([...DECK, empty], empty, "/repo"))).toBe("free");
  });

  it("teamOccupyingPath: the first holder across every workspace, roots included", () => {
    const at = (path: string) => {
      const found = teamOccupyingPath(DECK, path);
      return found ? `${found.ws.id}/${found.team.id}` : null;
    };
    expect(at("/repo")).toBe("ws-a/ta1");
    expect(at("/wt/a2/")).toBe("ws-a/ta2");
    expect(at("/wt/b3")).toBe("ws-b/tb3");
    expect(at("/wt/a3")).toBe("ws-a/ta3");
    expect(at("/nowhere")).toBeNull();
    expect(at("  ")).toBeNull();
  });

  it("directoriesStillHeld: what stays held once some of one workspace's teams end", () => {
    expect([...directoriesStillHeld(DECK, "ws-a", ["ta2", "ta3"])].sort()).toEqual(["/repo", "/wt/a2", "/wt/b3"]);
    expect([...directoriesStillHeld(DECK, "ws-b", ["tb1", "tb2", "tb3"])].sort()).toEqual(["/repo", "/wt/a2", "/wt/a3"]);
    // The same team id in another workspace is a different team.
    expect([...directoriesStillHeld(DECK, "ws-b", ["ta2"])].sort()).toEqual(["/repo", "/wt/a2", "/wt/a3", "/wt/b3"]);
    // ...and keeps its directory even when it is the only one there.
    const twins = [ws("ws-x", [attached("t1", "/wt/x")]), ws("ws-y", [attached("t1", "/wt/y")])];
    expect([...directoriesStillHeld(twins, "ws-x", ["t1"])]).toEqual(["/wt/y"]);
  });
});
