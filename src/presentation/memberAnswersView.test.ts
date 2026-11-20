import { describe, expect, it } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { membersNotTakenText, paneLabelsIn, UNKNOWN_PANE } from "./memberAnswersView";

const ws: Workspace = {
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "Web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [
    { id: "a", agentType: "claude" },
    { id: "b", agentType: "claude", name: "reviewer" },
  ],
};

const textOf = (outcome: "ok" | "no", label: string) => (outcome === "ok" ? null : `${label}: no.`);

describe("membersNotTakenText — a team's act, said member by member", () => {
  it("says each member it did not take, a line each in the act's order", () => {
    const labels = paneLabelsIn([ws], [], "ws-1");
    const text = membersNotTakenText(
      [
        { paneId: "b", outcome: "no" as const },
        { paneId: "a", outcome: "ok" as const },
        { paneId: "a", outcome: "no" as const },
      ],
      labels,
      textOf,
    );
    expect(text).toBe(`reviewer: no.\n${labels.get("a")}: no.`);
  });

  it("names a pane the deck no longer shows without inventing a title", () => {
    expect(membersNotTakenText([{ paneId: "gone", outcome: "no" as const }], new Map(), textOf)).toBe(`${UNKNOWN_PANE}: no.`);
  });

  it("says nothing when every member was taken, or nobody was asked", () => {
    expect(membersNotTakenText([{ paneId: "a", outcome: "ok" as const }], new Map(), textOf)).toBeNull();
    expect(membersNotTakenText([], new Map(), textOf)).toBeNull();
  });
});
