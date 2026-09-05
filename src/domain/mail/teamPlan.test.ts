import { describe, expect, it } from "vitest";
import { SENDABLE_KINDS } from "./message";
import { awaitsAnswer } from "./policy";
import type { Pane, Workspace } from "../deck";
import { createWorkspaceInstance } from "../workspaceInstance";
import { roleById } from "./roles";
import {
  planDisband,
  planTeam,
  teamBriefing,
  teamNamesIn,
  teamPlanIsEmpty,
  type TeamDraft,
} from "./teamPlan";

const pane = (id: string, team?: { name: string; role: string }): Pane =>
  ({ id, agentType: "claude", ...(team ? { team } : {}) }) as Pane;

const workspace = (panes: Pane[]): Workspace =>
  ({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "web",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  }) as Workspace;

const draft = (over: Partial<TeamDraft> = {}): TeamDraft => ({
  name: "api",
  members: [],
  recruits: [],
  ...over,
});

describe("planTeam", () => {
  it("settles members and trims what it stores", () => {
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    const result = planTeam(
      ws,
      draft({
        name: "  api  ",
        members: [
          { paneId: "pane-1", role: " lead " },
          { paneId: "pane-2", role: "impl-1" },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: "api",
        members: [
          { paneId: "pane-1", role: "lead" },
          { paneId: "pane-2", role: "impl-1" },
        ],
        released: [],
        recruits: [],
      },
    });
  });

  it("names who is being taken OUT of the team", () => {
    // A team is the set of panes holding its name, so anyone the draft
    // dropped has left. Saying so here is what stops the caller
    // re-deriving it — and re-derivation is how a member gets stranded on
    // a team nobody thinks they are on.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
      pane("pane-3", { name: "web", role: "lead" }),
    ]);
    const result = planTeam(
      ws,
      draft({ members: [{ paneId: "pane-1", role: "lead" }] }),
      "api",
    );
    expect(result.ok && result.value.released).toEqual(["pane-2"]);
    // A pane on ANOTHER team is not this team's business.
    expect(result.ok && result.value.released).not.toContain("pane-3");
  });

  it("counts a role an unspawned recruit will hold as taken", () => {
    // Checking only the live half is how a team ends up with two impl-1s
    // the moment the second one starts.
    const ws = workspace([pane("pane-1")]);
    const result = planTeam(
      ws,
      draft({
        members: [{ paneId: "pane-1", role: "impl-1" }],
        recruits: [{ agentType: "claude", role: "IMPL-1", yolo: false }],
      }),
    );
    expect(result.ok).toBe(false);
    // Quoted as the person TYPED it, so they can find it in the form —
    // echoing a normalised spelling sends them looking for a row that does
    // not read that way anywhere on screen.
    if (!result.ok) expect(result.message).toContain("IMPL-1");
  });

  it("refuses a nameless team and a roleless member", () => {
    const ws = workspace([pane("pane-1")]);
    expect(planTeam(ws, draft({ name: "  " })).ok).toBe(false);
    expect(
      planTeam(ws, draft({ members: [{ paneId: "pane-1", role: " " }] })).ok,
    ).toBe(false);
    expect(
      planTeam(ws, draft({ recruits: [{ agentType: "claude", role: "", yolo: false }] })).ok,
    ).toBe(false);
  });

  it("matches the team name however it was cased", () => {
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    const result = planTeam(ws, draft({ name: "API", members: [] }), "api");
    expect(result.ok && result.value.released).toEqual(["pane-1"]);
  });

  it("refuses a roster with no lead, and one with two", () => {
    // A team answers to someone: with no lead nobody hands out work, and
    // every member has been briefed to take it from a role that is not
    // there. With two, one question has two answers.
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    const headless = planTeam(
      ws,
      draft({ members: [{ paneId: "pane-1", role: "impl-1" }] }),
    );
    expect(headless.ok).toBe(false);
    if (!headless.ok) expect(headless.message).toContain("lead");
    const twoHeads = planTeam(
      ws,
      draft({
        members: [{ paneId: "pane-1", role: "lead" }],
        recruits: [{ agentType: "claude", role: "lead", yolo: false }],
      }),
    );
    expect(twoHeads.ok).toBe(false);
  });

  it("accepts a flat team of peers, where nobody leads", () => {
    // The second team shape: equals only. No lead to demand — the peer
    // charter names nobody to take direction from.
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    const result = planTeam(
      ws,
      draft({
        members: [
          { paneId: "pane-1", role: "peer-1" },
          { paneId: "pane-2", role: "peer-2" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("refuses to mix peers with led roles, either way around", () => {
    // "An equal under a boss" is a contradiction in the roster itself: the
    // peer charter says nobody outranks it, the worker charters name a lead.
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    for (const other of ["lead", "impl-1"]) {
      const result = planTeam(
        ws,
        draft({
          members: [
            { paneId: "pane-1", role: "peer-1" },
            { paneId: "pane-2", role: other },
          ],
        }),
      );
      expect(result.ok, other).toBe(false);
      if (!result.ok) expect(result.message).toContain("flat");
    }
  });

  it("refuses to take a pane that already belongs to another team", () => {
    // One team per pane. Poaching strands the team left behind: its members
    // stay briefed to address a role that reaches nobody. The dialog declines
    // to OFFER such a pane, but an agent driving `team.assign` reads no
    // dialog — so the rule lives here, with the teams.
    const ws = workspace([
      pane("pane-1"),
      pane("pane-2", { name: "web", role: "impl-1" }),
    ]);
    const result = planTeam(
      ws,
      draft({
        name: "api",
        members: [
          { paneId: "pane-1", role: "lead" },
          { paneId: "pane-2", role: "impl-1" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("web");
  });

  it("lets a team keep its own members, and keep them through a rename", () => {
    // The other side of the same rule: a member already on THIS team is
    // staying, not moving — including when the team is being renamed, where
    // what everyone holds is the OLD name.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
    ]);
    const members = [
      { paneId: "pane-1", role: "lead" },
      { paneId: "pane-2", role: "impl-1" },
    ];
    expect(planTeam(ws, draft({ name: "api", members }), "api").ok).toBe(true);
    expect(planTeam(ws, draft({ name: "platform", members }), "api").ok).toBe(true);
  });

  it("lets the same role live in a different team", () => {
    // A role is unique per TEAM, not per deck: `lead@api` and `lead@web` are
    // two members of two teams. The rule settles ONE roster, so another
    // team's lead is simply not in it.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2"),
    ]);
    expect(
      planTeam(ws, draft({ name: "web", members: [{ paneId: "pane-2", role: "lead" }] })).ok,
    ).toBe(true);
  });

  it("lets a member keep the role it already holds", () => {
    // Re-stating a roster unchanged — which every edit of an unrelated field
    // does — must not read as a pane colliding with itself.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    expect(
      planTeam(ws, draft({ name: "api", members: [{ paneId: "pane-1", role: "lead" }] }), "api")
        .ok,
    ).toBe(true);
  });

  it("refuses a role the catalog cannot account for", () => {
    // An unknown role has no charter, so its holder would be briefed with
    // nothing said about what it is for — the state roles exist to end.
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    const result = planTeam(
      ws,
      draft({
        members: [
          { paneId: "pane-1", role: "lead" },
          { paneId: "pane-2", role: "architect" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("architect");
  });

  it("still names who left when the team is renamed in the same breath", () => {
    // Who has LEFT is a question about the team as it stands, not about what
    // it is being renamed to. Answered against the new name, nobody holds it
    // yet, the released list comes back empty, and the dropped member keeps
    // a badge for a team it is no longer on. Reproduced live.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
    ]);
    const result = planTeam(
      ws,
      draft({ name: "platform", members: [{ paneId: "pane-1", role: "lead" }] }),
      "api",
    );
    expect(result.ok && result.value.released).toEqual(["pane-2"]);
    // And the one that stayed moves to the new name.
    expect(result.ok && result.value.name).toBe("platform");
    // The plan says what the released member actually HELD, so a farewell
    // can name the team it was on rather than the name it was changed to.
    expect(result.ok && result.value.formerName).toBe("api");
  });

  it("does not call a re-spelling of the same name a rename", () => {
    // The key decides: " API " is the team called "api", so nobody is
    // released and no former name is reported — a farewell would otherwise
    // have named a team that never changed.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    const result = planTeam(
      ws,
      draft({ name: " API ", members: [{ paneId: "pane-1", role: "lead" }] }),
      "api",
    );
    expect(result.ok && result.value.formerName).toBeUndefined();
    expect(result.ok && result.value.released).toEqual([]);
    // The badge keeps the spelling the person chose; only the key folds.
    expect(result.ok && result.value.name).toBe("API");
  });

  it("disbands without demanding a lead for the empty roster it leaves", () => {
    // An empty roster is not a team missing its head — it is a team being
    // taken apart, and demanding a lead there would make that impossible.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    const result = planTeam(ws, draft({ name: "api", members: [] }), "api");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.released).toEqual(["pane-1"]);
  });

  it("refuses to create or rename onto a name another team holds, however cased or padded", () => {
    // As a create it would read as an edit of that team and evict the
    // members the draft does not list; as a rename it would merge two teams
    // under one name. Judged here, not only in the dialog: an agent naming a
    // team over `team.assign` reads no dialog.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "web", role: "lead" }),
      pane("pane-3"),
    ]);
    const create = planTeam(
      ws,
      draft({ name: " API ", members: [{ paneId: "pane-3", role: "lead" }] }),
    );
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.message).toContain("already exists");
    const rename = planTeam(
      ws,
      draft({ name: "Web", members: [{ paneId: "pane-1", role: "lead" }] }),
      "api",
    );
    expect(rename.ok).toBe(false);
    if (!rename.ok) expect(rename.message).toContain("already exists");
  });

  it("lets the team being edited keep its own name, and be joined under it", () => {
    // Its own name back — re-spelled or not — is not another team's, and
    // `team.assign` names the team it joins as the one being edited.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" }), pane("pane-2")]);
    expect(
      planTeam(ws, draft({ name: "API", members: [{ paneId: "pane-1", role: "lead" }] }), "api")
        .ok,
    ).toBe(true);
    expect(
      planTeam(
        ws,
        draft({
          name: "api",
          members: [
            { paneId: "pane-1", role: "lead" },
            { paneId: "pane-2", role: "impl-1" },
          ],
        }),
        "api",
      ).ok,
    ).toBe(true);
  });

  it("knows a plan that asks for nothing", () => {
    const ws = workspace([pane("pane-1")]);
    const result = planTeam(ws, draft());
    expect(result.ok && teamPlanIsEmpty(result.value)).toBe(true);
    const withOne = planTeam(ws, draft({ members: [{ paneId: "pane-1", role: "lead" }] }));
    expect(withOne.ok && teamPlanIsEmpty(withOne.value)).toBe(false);
  });
});

describe("planDisband", () => {
  it("releases everyone holding the name and leaves nobody on it", () => {
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
      pane("pane-3", { name: "web", role: "lead" }),
      pane("pane-4"),
    ]);
    const plan = planDisband(ws, "api");
    expect(plan.ok && plan.value).toEqual({
      name: "api",
      members: [],
      // Another team's members and an unaffiliated pane are untouched — a
      // disband ends ONE team, and releasing a pane it does not own would
      // strip a role its teammates are still briefed to address.
      released: ["pane-1", "pane-2"],
      recruits: [],
    });
  });

  it("matches the name the way membership does, not the way a keyboard does", () => {
    // The same case- and space-insensitive rule `paneIsOnTeam` applies. A
    // disband that missed on capitalisation would report success and leave
    // the team running.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    const plan = planDisband(ws, "  API ");
    expect(plan.ok && plan.value.released).toEqual(["pane-1"]);
    // Trimmed, so the plan names the team rather than what was typed.
    expect(plan.ok && plan.value.name).toBe("API");
  });

  it("refuses a name nobody holds instead of answering with an empty plan", () => {
    // A disband that quietly does nothing is indistinguishable from one that
    // worked, to whoever asked for it. This was the one destructive gesture
    // that built its plan by hand and so passed no check at all.
    const ws = workspace([pane("pane-1", { name: "api", role: "lead" })]);
    for (const missing of ["web", "", "   "]) {
      const plan = planDisband(ws, missing);
      expect(plan.ok, JSON.stringify(missing)).toBe(false);
      if (!plan.ok) expect(plan.message).toContain("no team called");
    }
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
