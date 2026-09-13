import { describe, expect, it } from "vitest";
import { rootOptions } from "./rootOptionView";

describe("rootOptions", () => {
  it("names a team's tree by the team, with its branch and folder", () => {
    expect(
      rootOptions([
        { cwd: "/wt/kd-app-1", team: { id: "team-1", name: "api" }, branch: "kd/app/1", agents: 2, workspace: false },
      ]),
    ).toEqual([
      {
        value: "/wt/kd-app-1",
        title: "api",
        detail: "kd/app/1",
        folder: "kd-app-1",
        hint: "/wt/kd-app-1 · 2 agents",
      },
    ]);
  });

  it("falls back to the branch, then the folder, for a tree no team claims", () => {
    expect(
      rootOptions([
        { cwd: "/wt/lone", branch: "kd/lone", agents: 1, workspace: false },
        { cwd: "/wt/bare", agents: 1, workspace: false },
      ]),
    ).toEqual([
      { value: "/wt/lone", title: "kd/lone", folder: "lone", hint: "/wt/lone · 1 agent" },
      { value: "/wt/bare", title: "bare", hint: "/wt/bare · 1 agent" },
    ]);
  });

  it("the workspace folder says so", () => {
    expect(rootOptions([{ cwd: "/repo", agents: 0, workspace: true }])).toEqual([
      { value: "/repo", title: "Workspace folder", hint: "/repo · 0 agents" },
    ]);
  });
});
