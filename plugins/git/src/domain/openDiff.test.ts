import { describe, expect, it } from "vitest";
import { afterClose, afterSelection, openDiffFor, withRow } from "./openDiff";
import type { ChangeRow } from "./status";

const WS = { id: "ws-1", instance: "instance-1" };
const REOPENED = { id: "ws-1", instance: "instance-2" };
const OTHER = { id: "ws-2", instance: "instance-9" };

const row: ChangeRow = { path: "src/app.ts", origPath: null, code: "M", kind: "unstaged" };
const scope = { kind: "commit" as const, sha: "a1".repeat(20), subject: "add feature" };

describe("openDiffFor", () => {
  it("a Changes row opens on itself; a History scope opens with no file yet", () => {
    expect(openDiffFor({ repo: "/repo", workspace: WS, kind: "worktree", row })).toEqual({
      repo: "/repo",
      workspace: WS,
      kind: "worktree",
      row,
    });
    expect(openDiffFor({ repo: "/repo", workspace: WS, kind: "history", scope })).toEqual({
      repo: "/repo",
      workspace: WS,
      kind: "history",
      row: null,
      scope,
    });
  });
});

describe("withRow", () => {
  it("moves the diff to another row of its own change set, keeping the rest", () => {
    const diff = openDiffFor({ repo: "/repo", workspace: WS, kind: "history", scope });
    const next = withRow(diff, { ...row, kind: "history" });
    expect(next).toEqual({ ...diff, row: { ...row, kind: "history" } });
  });
});

describe("afterSelection", () => {
  const diff = openDiffFor({ repo: "/repo", workspace: WS, kind: "worktree", row });

  it("keeps the diff while the selection stays within its own workspace", () => {
    expect(afterSelection(diff, WS)).toBe(diff);
  });

  it("drops the diff once another workspace is in front", () => {
    expect(afterSelection(diff, OTHER)).toBeNull();
  });

  it("a workspace reopened under the same id is another workspace", () => {
    expect(afterSelection(diff, REOPENED)).toBeNull();
  });
});

describe("afterClose", () => {
  const diff = openDiffFor({ repo: "/repo", workspace: WS, kind: "worktree", row });

  it("drops the diff with its own workspace, keeps it through another's closing", () => {
    expect(afterClose(diff, OTHER)).toBe(diff);
    expect(afterClose(diff, REOPENED)).toBe(diff);
    expect(afterClose(diff, WS)).toBeNull();
  });
});
