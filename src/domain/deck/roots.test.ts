import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import type { Workspace } from "./workspaces";
import type { Pane } from "./panes";
import {
  pathBelongsTo,
  workspaceDirectories,
  withHistoricalDirectories,
} from "./roots";

const ws = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  ...over,
});

const pane = (id: string, cwd: string | undefined): Pane =>
  cwd !== undefined ? { id, location: { kind: "attached", cwd } } : { id };

describe("workspaceDirectories", () => {
  it("a shared base root brings no foreign folder in", () => {
    // Three workspaces plant worktrees under ONE base — the base is only a
    // suggestion of where worktrees may land, never a folder source: each
    // workspace's set holds its own cwd and its own panes' folders, and
    // none of the siblings'.
    const base = "/wt";
    const a = ws({
      id: "a",
      cwd: "/repo/a",
      worktreeBaseDir: base,
      panes: [pane("p1", `${base}/kd-a-1`), pane("p2", `${base}/kd-a-2`)],
    });
    const b = ws({ id: "b", cwd: "/repo/b", worktreeBaseDir: base, panes: [pane("p3", `${base}/kd-b-1`)] });
    const c = ws({ id: "c", cwd: "/repo/c", worktreeBaseDir: base, panes: [] });

    const setA = workspaceDirectories(a);
    expect([...setA].sort()).toEqual(["/repo/a", "/wt/kd-a-1", "/wt/kd-a-2"]);
    expect(pathBelongsTo(setA, "/wt/kd-b-1")).toBe(false);
    expect(pathBelongsTo(setA, "/repo/b")).toBe(false);
    expect(pathBelongsTo(workspaceDirectories(b), "/wt/kd-a-1")).toBe(false);
    expect([...workspaceDirectories(c)].sort()).toEqual(["/repo/c"]);
    // The base root itself is nobody's folder unless a pane runs in it.
    for (const set of [setA, workspaceDirectories(b)]) {
      expect(pathBelongsTo(set, base)).toBe(false);
    }
  });

  it("membership is an exact path, not a stem", () => {
    const set = workspaceDirectories(
      ws({ cwd: "/repo", panes: [pane("p1", "/wt/kd-KeepDeck-12")] }),
    );
    expect(pathBelongsTo(set, "/wt/kd-KeepDeck-1")).toBe(false);
    expect(pathBelongsTo(set, "/wt/kd-KeepDeck-12")).toBe(true);
    expect(pathBelongsTo(set, "/wt/kd-KeepDeck-12/inner")).toBe(false);
    // A session with no recorded directory belongs nowhere.
    expect(pathBelongsTo(set, "")).toBe(false);
  });

  it("a pane without a resolved cwd contributes nothing yet", () => {
    // Provisioning panes have no honest process location — falling back to
    // the workspace cwd would describe the wrong folder.
    const set = workspaceDirectories(
      ws({
        cwd: "/repo",
        panes: [
          {
            id: "p1",
            location: {
              kind: "provisioning",
              intent: { repo: "/repo", path: "/wt/a", index: 1 },
            },
          },
        ],
      }),
    );
    expect([...set]).toEqual(["/repo"]);
  });
});

describe("withHistoricalDirectories", () => {
  it("blank journal paths never land in the set", () => {
    const base = workspaceDirectories(ws({ cwd: "/repo" }));
    const grown = withHistoricalDirectories(base, ["", "/gone/wt"]);
    expect([...grown].sort()).toEqual(["/gone/wt", "/repo"]);
    // The input set is never mutated — builders stay composable.
    expect([...base]).toEqual(["/repo"]);
  });

  it("three builders, one predicate: each widening answers differently, the rule does not change", () => {
    // The substitutability pin: own-only, plus current panes, plus history
    // are three different SETS from three different builders, and the
    // predicate is the same function over each — no builder leaks its
    // method into the membership rule.
    const w = ws({
      cwd: "/repo",
      worktreeBaseDir: "/wt",
      panes: [pane("p1", "/wt/kd-a-1")],
    });
    const own = new Set([w.cwd]);
    const withPanes = workspaceDirectories(w);
    const withHistory = withHistoricalDirectories(withPanes, ["/old/dir", ""]);

    expect(pathBelongsTo(own, "/wt/kd-a-1")).toBe(false);
    expect(pathBelongsTo(withPanes, "/wt/kd-a-1")).toBe(true);
    expect(pathBelongsTo(withPanes, "/old/dir")).toBe(false);
    expect(pathBelongsTo(withHistory, "/old/dir")).toBe(true);
    expect(pathBelongsTo(withHistory, "")).toBe(false);
    // Sizes strictly widen: three builders, three sets.
    expect(own.size).toBe(1);
    expect(withPanes.size).toBe(2);
    expect(withHistory.size).toBe(3);
  });
});
