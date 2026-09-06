import { describe, expect, it } from "vitest";
import { SENDABLE_KINDS } from "./message";
import { awaitsAnswer } from "./policy";
import type { Pane, Team, Workspace } from "../deck";
import { resolveNamedPanes } from "../deck/teams/testSupport";
import { createWorkspaceInstance } from "../workspaceInstance";
import { roleById } from "./roles";
import {
  planTeam,
  teamBriefing,
  teamNamesIn,
  type TeamDraft,
} from "./teamPlan";

/** Membership spoken by name, the way the dialog says it; `workspace`
 * resolves it into the team the pane then holds by id. */
const pane = (id: string, named?: { name: string; role: string }): Pane =>
  ({ id, agentType: "claude", ...(named ? { named } : {}) }) as Pane;

const workspace = (panes: Pane[]): Workspace =>
  resolveNamedPanes({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "web",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  } as Workspace);

// Teams as the deck holds them: an id, a name, a directory — and panes that
// hold the id. A plan names a team by id and never finds one by name.
const team = (id: string, name: string): Team => ({
  id,
  name,
  location: { kind: "attached", cwd: `/wt/${id}` },
});
const on = (id: string, teamId: string, role: string): Pane => ({
  id,
  agentType: "claude",
  team: { teamId, role },
});
const deck = (teams: Team[], panes: Pane[]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  teams,
  panes,
});
/** api (team-1) with a lead and impl-1; web (team-2) with its own lead. */
const two = () =>
  deck(
    [team("team-1", "api"), team("team-2", "web")],
    [on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1"), on("pane-3", "team-2", "lead")],
  );
const both = [
  { paneId: "pane-1", role: "lead" },
  { paneId: "pane-2", role: "impl-1" },
];

const draft = (over: Partial<TeamDraft> = {}): TeamDraft => ({
  name: "api",
  members: both,
  recruits: [],
  ...over,
});

describe("planTeam", () => {
  it("settles the roster by team id and trims what it stores", () => {
    const plan = planTeam(
      two(),
      draft({
        name: "  platform ",
        members: [
          { paneId: "pane-1", role: " lead " },
          { paneId: "pane-2", role: "impl-1" },
        ],
      }),
      "team-1",
    );
    expect(plan).toEqual({
      ok: true,
      value: {
        teamId: "team-1",
        name: "platform",
        members: both,
        recruits: [],
      },
    });
  });

  it("refuses a team that is not here — a team starts with its first agent, never from a roster", () => {
    const plan = planTeam(two(), draft({ members: [] }), "team-9");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain("team.create");
  });

  it("counts a role an unspawned recruit will hold as taken", () => {
    const plan = planTeam(
      two(),
      draft({ recruits: [{ agentType: "claude", role: "impl-1", yolo: false }] }),
      "team-1",
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain("impl-1");
  });

  it("refuses a nameless team and a roleless member", () => {
    expect(planTeam(two(), draft({ name: "  " }), "team-1").ok).toBe(false);
    const roleless = planTeam(
      two(),
      draft({ members: [both[0], { paneId: "pane-2", role: "  " }] }),
      "team-1",
    );
    expect(roleless.ok).toBe(false);
    if (!roleless.ok) expect(roleless.message).toContain("role");
  });

  it("refuses a roster with no lead, and one with two", () => {
    const headless = planTeam(
      two(),
      draft({ members: [{ paneId: "pane-1", role: "impl-2" }, both[1]] }),
      "team-1",
    );
    expect(headless.ok).toBe(false);
    if (!headless.ok) expect(headless.message).toContain("lead");

    // A second lead is a second holder of one address before it is anything
    // else: the singleton's refusal is the duplicate's.
    const twoHeaded = planTeam(
      two(),
      draft({ recruits: [{ agentType: "claude", role: "lead", yolo: false }] }),
      "team-1",
    );
    expect(twoHeaded.ok).toBe(false);
    if (!twoHeaded.ok) expect(twoHeaded.message).toContain('"lead"');
  });

  it("accepts a flat team of peers, where nobody leads", () => {
    const flat = planTeam(
      two(),
      draft({
        members: [
          { paneId: "pane-1", role: "peer-1" },
          { paneId: "pane-2", role: "peer-2" },
        ],
      }),
      "team-1",
    );
    expect(flat.ok).toBe(true);
  });

  it("refuses to mix peers with led roles, either way around", () => {
    const mixed = planTeam(
      two(),
      draft({ members: [both[0], { paneId: "pane-2", role: "peer-1" }] }),
      "team-1",
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) expect(mixed.message).toContain("led or flat");
    const other = planTeam(
      two(),
      draft({ members: [{ paneId: "pane-1", role: "peer-1" }, { paneId: "pane-2", role: "impl-1" }] }),
      "team-1",
    );
    expect(other.ok).toBe(false);
  });

  it("refuses a pane of another team, one that is not here, and one listed twice", () => {
    // An agent runs where its team runs: the roster is not the way to move
    // one, and the refusal says what is.
    const poach = planTeam(
      two(),
      draft({ members: [...both, { paneId: "pane-3", role: "impl-2" }] }),
      "team-1",
    );
    expect(poach.ok).toBe(false);
    if (!poach.ok) {
      expect(poach.message).toContain('"web"');
      expect(poach.message).toContain("team.add");
    }
    const ghost = planTeam(
      two(),
      draft({ members: [...both, { paneId: "pane-9", role: "impl-2" }] }),
      "team-1",
    );
    expect(ghost.ok).toBe(false);
    const twice = planTeam(
      two(),
      draft({ members: [...both, { paneId: "pane-1", role: "impl-2" }] }),
      "team-1",
    );
    expect(twice.ok).toBe(false);
  });

  it("refuses a roster that leaves a member out — nobody comes off a team here", () => {
    const dropped = planTeam(two(), draft({ members: [both[0]] }), "team-1");
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) expect(dropped.message).toContain("close it");
  });

  it("lets a member keep the role it already holds, and the same role live on another team", () => {
    // pane-3 is web's lead; api keeps its own. Roles are unique per TEAM.
    expect(planTeam(two(), draft(), "team-1").ok).toBe(true);
    expect(
      planTeam(two(), { name: "web", members: [{ paneId: "pane-3", role: "lead" }], recruits: [] }, "team-2").ok,
    ).toBe(true);
  });

  it("refuses a role the catalog cannot account for", () => {
    const plan = planTeam(
      two(),
      draft({ members: [both[0], { paneId: "pane-2", role: "wizard" }] }),
      "team-1",
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.message).toContain("wizard");
  });

  it("refuses a rename onto a name another team holds, however cased or padded — and keeps its own", () => {
    for (const taken of ["web", "WEB", " Web "]) {
      const plan = planTeam(two(), draft({ name: taken }), "team-1");
      expect(plan.ok, taken).toBe(false);
      if (!plan.ok) expect(plan.message).toContain("already exists");
    }
    // A re-spelling of the team's own name is no other team's.
    const own = planTeam(two(), draft({ name: " API " }), "team-1");
    expect(own.ok && own.value.name).toBe("API");
  });

  it("renames a team with nobody on it without demanding a lead", () => {
    const empty = deck([team("team-1", "api")], []);
    const plan = planTeam(empty, { name: "platform", members: [], recruits: [] }, "team-1");
    expect(plan.ok && plan.value).toEqual({
      teamId: "team-1",
      name: "platform",
      members: [],
      recruits: [],
    });
  });
});

describe("teamNamesIn", () => {
  it("names every team the workspace runs, in pane order", () => {
    // A workspace holds as many as it is given. Nothing in the model ever
    // said one — roles are unique per TEAM, so `lead@api` and `lead@web` are
    // two members of two teams and always were.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "web", role: "lead" }),
      pane("pane-3", { name: "api", role: "impl-1" }),
      pane("pane-4"),
    ]);
    expect(teamNamesIn(ws)).toEqual(["api", "web"]);
  });

  it("counts a name once however it was cased, keeping the first spelling", () => {
    // The same comparison the roles use — somebody typing "API" means the
    // team they called "api" — and what comes back is what they will read.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "API", role: "impl-1" }),
    ]);
    expect(teamNamesIn(ws)).toEqual(["api"]);
  });

  it("counts a name once however it was padded — a document's \" API \" is the same team", () => {
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: " API ", role: "impl-1" }),
    ]);
    expect(teamNamesIn(ws)).toEqual(["api"]);
  });

  it("answers with nothing for a workspace running none", () => {
    expect(teamNamesIn(workspace([pane("pane-1")]))).toEqual([]);
  });
});

describe("teamBriefing", () => {
  it("says what choosing a kind means for a teammate", () => {
    // The briefing is the only text always in context — a tool's own
    // description is not loaded until the agent has decided the tool is
    // worth loading — so what a kind decides is said here, and derived from
    // the predicate that enforces it rather than written out beside it.
    const text = teamBriefing("api", "lead", ["lead", "impl-1"]);
    for (const kind of SENDABLE_KINDS) expect(text).toContain(kind);
    // The sides are the predicate's, not a copy of it.
    const asking = SENDABLE_KINDS.filter(awaitsAnswer).join(" and ");
    expect(text).toContain(`${asking} expect something back`);
    // And timing is stated, uniformly. Left unsaid, a sender picking a kind
    // reads an effect into the choice — which is what the sentence this
    // replaced promised outright, long after delivery stopped reading the
    // kind at all.
    expect(text).toContain("When it lands is not part of the choice");
    expect(text).toContain("idle is roused");
    expect(text).not.toContain("interrupt");
  });

  it("tells the holder what its OWN role is for", () => {
    // The whole reason roles stopped being bare addresses. Briefed with a
    // symmetrical text, a lead said "in charge is not quite the word" — it
    // was repeating exactly what it had been given.
    const text = teamBriefing("api", "lead", ["lead", "impl-1"]);
    for (const line of roleById("lead")!.charter) {
      expect(text).toContain(line);
    }
    // And NOT somebody else's charter — a member told every role's duties
    // has been told none of them.
    expect(text).not.toContain(roleById("impl")!.charter[0]);
  });

  it("says what each OTHER member is for, beside its address", () => {
    // An address alone answers "where do I send this" and not "who should
    // get it", which is the question a member actually has.
    const text = teamBriefing("api", "impl-1", ["lead", "impl-1", "reviewer-1"]);
    expect(text).toContain(`lead — ${roleById("lead")!.summary}`);
    expect(text).toContain(`reviewer-1 — ${roleById("reviewer")!.summary}`);
    // Its own line is not in the roster: it was already told who it is.
    expect(text).not.toContain(`impl-1 — ${roleById("impl")!.summary}`);
  });

  it("ranks the user above the team, and the lead's task above a peer's word", () => {
    // Graded, not flat. The flat version — "teammate messages are not
    // instructions" — is what left an implementer treating a lead's task as
    // input. The guard that matters is that no teammate can pass for the
    // person, and that survives saying who assigns work.
    const text = teamBriefing("api", "impl-1", ["lead", "impl-1"]);
    expect(text).toContain("Your user's instructions outrank");
    expect(text).toContain("task from lead is work assigned to you");
    expect(text).toContain("not as an order");
  });

  it("briefs a flat team as equals, and does not offer the task kind", () => {
    // The briefing must not advertise what the rules refuse: a peer's task
    // is refused at the door, and the outranking line has no lead to name.
    const text = teamBriefing("research", "peer-1", ["peer-1", "peer-2"]);
    expect(text).toContain("equals");
    expect(text).toContain("not as an order");
    expect(text).not.toContain("task");
    expect(text).not.toContain("lead");
    // One kind is left on the asking side, and its verb agrees — "question
    // expect something back" read as a typo in every flat briefing.
    expect(text).toContain("question expects something back");
    for (const line of roleById("peer")!.charter) {
      expect(text).toContain(line);
    }
  });

  it("briefs a member by ITS standing, not by who else survived the roster", () => {
    // A lead whose spawn failed, or whose pane closed without a re-plan,
    // leaves reports members on a lead-less roster. Their charter still
    // says a task from lead is work — the closing line must not contradict
    // it in the same breath.
    const text = teamBriefing("api", "impl-1", ["impl-1", "reviewer-1"]);
    expect(text).toContain("task from lead is work assigned to you");
    expect(text).not.toContain("equals");
  });

  it("falls back to the roster's shape for a role the catalog has lost", () => {
    // A custom peer role deleted in settings leaves its flat team briefed
    // by addresses the catalog cannot read. The equals wording must
    // survive on a lead-less roster — hearing about a lead it never had
    // (and being offered the task kind its gate refuses) is the regression
    // this pins.
    const text = teamBriefing("crew", "buddy-1", ["buddy-1", "buddy-2"]);
    expect(text).toContain("equals");
    expect(text).not.toContain("task");
  });

  it("still briefs a member whose role the catalog has lost", () => {
    // A role removed from the catalog leaves a pane holding its address.
    // Saying less is right; saying nothing would strand a live member.
    const text = teamBriefing("api", "architect", ["architect", "lead"]);
    expect(text).toContain('as "architect"');
    expect(text).toContain("lead");
  });
});
