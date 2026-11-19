import { describe, expect, it } from "vitest";
import { MAX_PANES, TEAM_FULL_MESSAGE, type Team, type TeamActs, type Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { teamMenuView, type TeamMenuItem } from "./teamMenuView";

const attached: Team = { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/.wt/api" } };
const failed: Team = {
  id: "team-1",
  name: "api",
  location: { kind: "provisioning", intent: { repo: "/repo", path: "/repo/.wt/api", index: 1 }, error: "branch exists" },
};

const ws = (members = 2): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: "/repo/.wt",
  teams: [attached],
  panes: Array.from({ length: members }, (_, i) => ({
    id: `p${i + 1}`,
    agentType: "claude",
    team: { teamId: "team-1", role: `impl-${i + 1}` },
  })),
});

type Skip<K extends keyof TeamActs> = TeamActs[K]["skip"][number]["why"];
const acts = (
  suspend: { take?: string[]; skip?: Skip<"suspend">[] } = {},
  resume: { take?: string[]; skip?: Skip<"resume">[] } = {},
): TeamActs => ({
  suspend: { take: suspend.take ?? [], skip: (suspend.skip ?? []).map((why, i) => ({ paneId: `s${i}`, why })) },
  resume: { take: resume.take ?? [], skip: (resume.skip ?? []).map((why, i) => ({ paneId: `r${i}`, why })) },
});

const line = (items: TeamMenuItem[], action: TeamMenuItem["action"]) => items.find((item) => item.action === action);

describe("teamMenuView — one line-set for the card's ⋯ and the crumb's", () => {
  it("offers every line on both surfaces, the card leading with the team and the crumb with its agents", () => {
    const live = acts({ take: ["p1"] }, { skip: ["running"] });
    expect(teamMenuView(ws(), attached, live, "card").map((item) => item.action)).toEqual([
      "add-member",
      "rename",
      "resume",
      "suspend",
      "disband",
    ]);
    expect(teamMenuView(ws(), attached, live, "crumb").map((item) => item.action)).toEqual([
      "resume",
      "suspend",
      "add-member",
      "rename",
      "disband",
    ]);
  });

  it("adds Retry last after a failed create, on both surfaces", () => {
    for (const surface of ["card", "crumb"] as const) {
      const items = teamMenuView(ws(), failed, acts({ skip: ["provisioning"] }), surface);
      expect(items[items.length - 1]).toEqual({ action: "retry", label: "Retry the worktree", refusal: null });
    }
  });

  it("counts whom Resume takes, and keeps Suspend plain — the confirm carries its numbers", () => {
    const items = teamMenuView(ws(), attached, acts({ take: ["p1"] }, { take: ["p2", "p3", "p4"] }), "card");
    expect(line(items, "resume")).toEqual({ action: "resume", label: "Resume 3 stopped agents", refusal: null });
    expect(line(items, "suspend")).toEqual({ action: "suspend", label: "Suspend team", refusal: null });
    const one = teamMenuView(ws(), attached, acts({}, { take: ["p2"] }), "card");
    expect(line(one, "resume")?.label).toBe("Resume 1 stopped agent");
  });

  describe("a Resume with nobody to take says the real reason", () => {
    const refusal = (...skip: Skip<"resume">[]) =>
      line(teamMenuView(ws(), attached, acts({}, { skip }), "card"), "resume");

    it("keeps the line, disabled, under its plain name", () => {
      expect(refusal("running")).toEqual({
        action: "resume",
        label: "Resume team",
        refusal: "No agent on this team is stopped.",
      });
    });

    it("tells nobody-down apart from down-but-not-coming-back", () => {
      expect(refusal("running", "waking")?.refusal).toBe("No agent on this team is stopped.");
      expect(refusal("blocked")?.refusal).toBe("No stopped agent can be resumed — its folder is gone.");
      expect(refusal("blocked", "running", "blocked")?.refusal).toBe(
        "No stopped agent can be resumed — their folders are gone.",
      );
      expect(refusal("blocked", "remote")?.refusal).toBe("No stopped agent can be resumed right now.");
      expect(refusal("unavailable")?.refusal).toBe("No stopped agent can be resumed right now.");
    });

    it("says a reason the whole team shares in the single Resume's own sentence", () => {
      expect(refusal("provisioning")?.refusal).toBe("This team is still creating its worktree.");
      expect(refusal("archived")?.refusal).toBe(
        "This team is in an archived workspace — restore the workspace first.",
      );
    });

    it("says so for a team with nobody on it", () => {
      expect(refusal()?.refusal).toBe("This team has no agents.");
    });
  });

  describe("a Suspend with nobody to take says the real reason", () => {
    const refusal = (...skip: Skip<"suspend">[]) =>
      line(teamMenuView(ws(), attached, acts({ skip }), "crumb"), "suspend")?.refusal;

    it("names nothing running, a running agent on a server, and a worktree still being made", () => {
      expect(refusal("stopped", "stopped")).toBe("Nothing on this team is running.");
      expect(refusal("stopped", "remote")).toBe(
        "Its running agents run on a remote server — stopping the local client would not park them.",
      );
      expect(refusal("provisioning")).toBe("This team is still creating its worktree.");
      expect(refusal()).toBe("This team has no agents.");
    });
  });

  it("offers nothing for a team the orchestrator no longer holds", () => {
    expect(teamMenuView(ws(), attached, null, "card")).toEqual([]);
  });

  it("refuses a member to a full team in the cap's own message", () => {
    const items = teamMenuView(ws(MAX_PANES), attached, acts(), "card");
    expect(line(items, "add-member")?.refusal).toBe(TEAM_FULL_MESSAGE);
    expect(line(teamMenuView(ws(1), attached, acts(), "card"), "add-member")?.refusal).toBeNull();
  });
});
