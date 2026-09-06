import { describe, expect, it } from "vitest";
import type { AgentDialogResult } from "../../agents";
import { paneFromAgentRequest } from ".";

describe("paneFromAgentRequest", () => {
  const workspace = { cwd: "/repo" };
  const request = (over: Partial<AgentDialogResult> = {}): AgentDialogResult => ({
    agentType: "claude",
    name: "",
    location: { kind: "main" },
    yolo: false,
    ...over,
  });

  it("shapes a bare pane headed for the workspace root", () => {
    expect(paneFromAgentRequest("pane-1", request(), workspace, 1)).toEqual({
      pane: { id: "pane-1", agentType: "claude" },
      placement: { kind: "attached", cwd: "/repo" },
    });
  });

  it("carries the endpoint on the pane and nothing local — the thin client runs in the root", () => {
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
      pane: {
        id: "pane-1",
        agentType: "claude",
        location: { kind: "remote", endpoint: "wss://vps" },
      },
      placement: { kind: "attached", cwd: "/repo" },
    });
  });

  it("asks for an existing worktree by cwd and branch", () => {
    expect(
      paneFromAgentRequest(
        "pane-2",
        request({ location: { kind: "existing", path: "/wt/a", branch: "kd/a" } }),
        workspace,
        3,
      ),
    ).toEqual({
      pane: { id: "pane-2", agentType: "claude" },
      placement: { kind: "attached", cwd: "/wt/a", branch: "kd/a" },
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
      pane: { id: "pane-3", agentType: "claude" },
      placement: {
        kind: "provisioning",
        intent: {
          repo: "/repo",
          path: "/wt/kd-deck-3",
          branch: "kd/deck/3",
          base: "release",
          index: 3,
        },
      },
    });
  });

  it("keeps unset fields off the pane and the intent", () => {
    const { pane, placement } = paneFromAgentRequest(
      "pane-4",
      request({
        name: "   ",
        location: { kind: "new", path: "/wt/a", branch: "", baseBranch: "" },
      }),
      workspace,
      1,
    );
    expect(Object.keys(pane).sort()).toEqual(["agentType", "id"]);
    if (placement.kind !== "provisioning") throw new Error("expected a create");
    expect(Object.keys(placement.intent).sort()).toEqual(["index", "path", "repo"]);
  });

  it("trims the name and arms yolo only when asked", () => {
    expect(
      paneFromAgentRequest(
        "pane-5",
        request({ name: "  planner  ", yolo: true }),
        workspace,
        1,
      ).pane,
    ).toEqual({
      id: "pane-5",
      name: "planner",
      agentType: "claude",
      yolo: true,
    });
  });
});
