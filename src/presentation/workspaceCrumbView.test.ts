import { describe, expect, it } from "vitest";
import { workspaceMenuView } from "./workspaceCrumbView";

const TARGET = { moveUp: null, moveDown: { after: "b" } };
const summary = (surface: "mark" | "crumb") =>
  workspaceMenuView(TARGET, surface).map((item) => `${item.separatorBefore ? "| " : ""}${item.label}`);

describe("workspaceMenuView", () => {
  it("offers rename, both moves, settings, archive and close — a move refused past its end", () => {
    expect(workspaceMenuView(TARGET, "crumb")).toEqual([
      { id: "rename", kind: "rename", label: "Rename", disabled: false, separatorBefore: false },
      { id: "up", kind: "move", label: "Move up", place: null, disabled: true, separatorBefore: false },
      { id: "down", kind: "move", label: "Move down", place: { after: "b" }, disabled: false, separatorBefore: false },
      { id: "settings", kind: "settings", label: "Workspace settings…", disabled: false, separatorBefore: true },
      { id: "archive", kind: "archive", label: "Archive…", disabled: false, separatorBefore: false },
      { id: "close", kind: "close", label: "Close workspace", disabled: false, separatorBefore: true },
    ]);
  });

  it("serves ONE set of lines in two orders: the same lines and refusals, arranged per surface", () => {
    const sorted = (surface: "mark" | "crumb") =>
      workspaceMenuView(TARGET, surface)
        .map(({ separatorBefore: _group, ...line }) => line)
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(sorted("mark")).toEqual(sorted("crumb"));
    // A mark leads with putting the workspace away; the crumb with naming
    // and placing the one in front of the person. Close ends both.
    expect(summary("mark")).toEqual([
      "Workspace settings…",
      "Archive…",
      "| Rename",
      "Move up",
      "Move down",
      "| Close workspace",
    ]);
    expect(summary("crumb")).toEqual([
      "Rename",
      "Move up",
      "Move down",
      "| Workspace settings…",
      "Archive…",
      "| Close workspace",
    ]);
  });
});
