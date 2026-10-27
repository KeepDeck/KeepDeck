import { describe, expect, it } from "vitest";
import type { AgentDialogResult } from "../../agents";
import { paneFromAgentRequest, placementFromAgentRequest } from ".";

const workspace = { cwd: "/repo" };
const request = (over: Partial<AgentDialogResult> = {}): AgentDialogResult => ({
  agentType: null,
  name: "",
  location: { kind: "main" },
  yolo: false,
  ...over,
});

describe("placementFromAgentRequest", () => {
  it("heads for the workspace root from the main repo", () => {
    expect(placementFromAgentRequest(request(), workspace, 1)).toEqual({
      kind: "attached",
      cwd: "/repo",
    });
  });

  it("keeps a remote agent on the root, whatever local location the form held", () => {
    expect(
      placementFromAgentRequest(
        request({
          location: { kind: "existing", path: "/wt/a", branch: "kd/a" },
          remoteEndpoint: "wss://vps",
        }),
        workspace,
        1,
      ),
    ).toEqual({ kind: "attached", cwd: "/repo" });
  });

  it("asks for an existing worktree by cwd and branch", () => {
    expect(
      placementFromAgentRequest(
        request({ location: { kind: "existing", path: "/wt/a", branch: "kd/a" } }),
        workspace,
        3,
      ),
    ).toEqual({ kind: "attached", cwd: "/wt/a", branch: "kd/a" });
  });

  it("carries the create intent for a worktree that does not exist yet", () => {
    expect(
      placementFromAgentRequest(
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
      kind: "provisioning",
      intent: {
        repo: "/repo",
        path: "/wt/kd-deck-3",
        branch: "kd/deck/3",
        base: "release",
        index: 3,
      },
    });
  });

  it("keeps unset fields off the intent", () => {
    const placement = placementFromAgentRequest(
      request({ location: { kind: "new", path: "/wt/a", branch: "", baseBranch: "" } }),
      workspace,
      1,
    );
    if (placement.kind !== "provisioning") throw new Error("expected a create");
    expect(Object.keys(placement.intent).sort()).toEqual(["index", "path", "repo"]);
  });

  it("needs no agent — a new team is a name and a directory", () => {
    expect(placementFromAgentRequest(request({ agentType: null }), workspace, 1)).toEqual({
      kind: "attached",
      cwd: "/repo",
    });
  });
});

describe("paneFromAgentRequest", () => {
  it("shapes a bare pane running the agent it is given, at the request's placement", () => {
    expect(paneFromAgentRequest("pane-1", "codex", request(), workspace, 1)).toEqual({
      pane: { id: "pane-1", agentType: "codex" },
      placement: { kind: "attached", cwd: "/repo" },
    });
  });

  it("carries the endpoint on the pane — the thin client runs in the root", () => {
    expect(
      paneFromAgentRequest(
        "pane-1",
        "codex",
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
        agentType: "codex",
        location: { kind: "remote", endpoint: "wss://vps" },
      },
      placement: { kind: "attached", cwd: "/repo" },
    });
  });

  it("keeps unset fields off the pane", () => {
    const { pane } = paneFromAgentRequest("pane-4", "claude", request({ name: "   " }), workspace, 1);
    expect(Object.keys(pane).sort()).toEqual(["agentType", "id"]);
  });

  it("trims the name and arms yolo only when asked", () => {
    expect(
      paneFromAgentRequest(
        "pane-5",
        "claude",
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
