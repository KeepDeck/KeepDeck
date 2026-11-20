import { describe, expect, it } from "vitest";
import type { AgentDialogResult } from "../agents";
import { agentDraftFromRequest, claimingTeams, siteFromAgentRequest } from "./requests";

const request = (over: Partial<AgentDialogResult> = {}): AgentDialogResult => ({
  agentType: null,
  name: "",
  location: { kind: "main" },
  yolo: false,
  ...over,
});

describe("siteFromAgentRequest", () => {
  it("runs on the root from the main repo, and a remote agent there whatever folder the form held", () => {
    expect(siteFromAgentRequest(request())).toEqual({ kind: "root" });
    expect(
      siteFromAgentRequest(request({ location: { kind: "existing", path: "/wt/a", branch: "kd/a" }, remoteEndpoint: "wss://vps" })),
    ).toEqual({ kind: "root" });
  });

  it("asks for a folder that exists by its path", () => {
    expect(siteFromAgentRequest(request({ location: { kind: "existing", path: "/wt/a", branch: "kd/a" } }))).toEqual({
      kind: "existing",
      cwd: "/wt/a",
    });
  });

  it("asks for a new worktree at the place the form names, from its base", () => {
    expect(
      siteFromAgentRequest(request({ location: { kind: "new", path: "/wt/kd-deck-3", branch: "kd/deck/3", baseBranch: "release" } })),
    ).toEqual({ kind: "new", place: { path: "/wt/kd-deck-3", branch: "kd/deck/3" }, base: "release" });
  });

  it("leaves the place to the machine when the form names no branch, and the base to HEAD when it names none", () => {
    expect(siteFromAgentRequest(request({ location: { kind: "new", path: "/wt/a", branch: " ", baseBranch: "" } }))).toEqual({
      kind: "new",
      place: null,
      base: null,
    });
  });
});

describe("claimingTeams", () => {
  it("names the teams among a folder's claims, and nothing else", () => {
    expect(claimingTeams([{ kind: "session", session: 1 }, { kind: "team", team: "team-1" }, { kind: "removal", op: 2 }, { kind: "team", team: "team-2" }])).toEqual([
      "team-1",
      "team-2",
    ]);
  });
});

describe("agentDraftFromRequest", () => {
  it("keeps only what is set, and a remote agent's endpoint", () => {
    expect(agentDraftFromRequest("claude", request({ name: "  " }))).toEqual({ agentType: "claude" });
    expect(agentDraftFromRequest("claude", request({ name: " api ", yolo: true, remoteEndpoint: "wss://vps" }))).toEqual({
      agentType: "claude",
      name: "api",
      yolo: true,
      location: { kind: "remote", endpoint: "wss://vps" },
    });
  });
});
