import { describe, expect, it } from "vitest";
import type { AgentDialogResult } from "../../agents";
import { MAX_PANES } from "../layout";
import { makePanes, makeProvisioningPanes, paneFromAgentRequest } from ".";

describe("paneFromAgentRequest", () => {
  const workspace = { cwd: "/repo", name: "deck" };
  const request = (over: Partial<AgentDialogResult> = {}): AgentDialogResult => ({
    agentType: "claude",
    name: "",
    location: { kind: "main" },
    yolo: false,
    ...over,
  });

  it("shapes a bare pane for the main repo", () => {
    expect(paneFromAgentRequest("pane-1", request(), workspace, 1)).toEqual({
      id: "pane-1",
      agentType: "claude",
    });
  });

  it("carries the endpoint and nothing local for a remote agent", () => {
    expect(
      paneFromAgentRequest(
        "pane-1",
        request({
          location: { kind: "existing", path: "/wt/a", branch: "kd/a" },
          remoteEndpoint: "wss://vps",
        }),
        workspace,
        1,
      ),
    ).toEqual({
      id: "pane-1",
      agentType: "claude",
      remoteEndpoint: "wss://vps",
    });
  });

  it("pins an existing worktree by cwd and branch", () => {
    expect(
      paneFromAgentRequest(
        "pane-2",
        request({ location: { kind: "existing", path: "/wt/a", branch: "kd/a" } }),
        workspace,
        3,
      ),
    ).toEqual({
      id: "pane-2",
      agentType: "claude",
      cwd: "/wt/a",
      branch: "kd/a",
    });
  });

  it("carries the create intent for a worktree that does not exist yet", () => {
    expect(
      paneFromAgentRequest(
        "pane-3",
        request({
          location: {
            kind: "new",
            path: "/wt/kd-deck-3",
            branch: "kd/deck/3",
            baseBranch: "release",
          },
        }),
        workspace,
        3,
      ),
    ).toEqual({
      id: "pane-3",
      agentType: "claude",
      provisioning: {
        repo: "/repo",
        path: "/wt/kd-deck-3",
        branch: "kd/deck/3",
        base: "release",
        workspace: "deck",
        index: 3,
      },
    });
  });

  it("never stamps runsSetup for a pane added after the batch", () => {
    const pane = paneFromAgentRequest(
      "pane-3",
      request({
        location: { kind: "new", path: "/wt/a", branch: "kd/a" },
      }),
      workspace,
      1,
    );
    expect(pane.provisioning?.runsSetup).toBeUndefined();
  });

  it("keeps unset fields off the pane", () => {
    const pane = paneFromAgentRequest(
      "pane-4",
      request({
        name: "   ",
        location: { kind: "new", path: "/wt/a", branch: "", baseBranch: "" },
      }),
      workspace,
      1,
    );
    expect(Object.keys(pane).sort()).toEqual(["agentType", "id", "provisioning"]);
    expect(Object.keys(pane.provisioning!).sort()).toEqual([
      "index",
      "path",
      "repo",
      "workspace",
    ]);
  });

  it("trims the name and arms yolo only when asked", () => {
    expect(
      paneFromAgentRequest(
        "pane-5",
        request({ name: "  planner  ", yolo: true }),
        workspace,
        1,
      ),
    ).toEqual({
      id: "pane-5",
      name: "planner",
      agentType: "claude",
      yolo: true,
    });
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
