import { describe, expect, it } from "vitest";
import {
  createCommandRegistry,
  type CommandArgs,
  type CommandRegistry,
  type CommandSource,
} from "../../domain/commands";
import { renameTeam, settleRoster, type Pane, type Team, type Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { PaneActivity } from "../../domain/status";
import { registerMailCommands } from "./mailCommands";
import { createMailManager } from "./mailManager";

const READY: PaneActivity = { state: "done", at: 1, interrupted: false };

const pane = (id: string, team?: { teamId: string; role: string }): Pane => ({
  id,
  agentType: "claude",
  ...(team && { team }),
});

const workspace = (id: string, name: string, panes: Pane[], teams?: Team[]): Workspace =>
  ({
    id,
    instance: createWorkspaceInstance(),
    name,
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
    ...(teams && { teams }),
  }) as Workspace;

/** ws-1's teams, when a case asks for them: api (team-1) with pane-1 as
 * lead and pane-2 as impl-1, and web (team-2) with nobody on it yet. */
const TEAMED: Team[] = [
  { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/.wt/api" } },
  { id: "team-2", name: "web", location: { kind: "attached", cwd: "/repo/.wt/web" } },
];

/** A caller identified as a pane, the way the MCP transport mints it. */
function from(paneId: string, workspaceId: string, label: string): CommandSource {
  return {
    kind: "external",
    client: "mcp",
    pane: { id: paneId, workspaceId, label },
  };
}

const ANONYMOUS: CommandSource = { kind: "external", client: "mcp" };

function setup(teamed = false) {
  const workspaces = teamed
    ? [
        workspace(
          "ws-1",
          "web",
          [
            pane("pane-1", { teamId: "team-1", role: "lead" }),
            pane("pane-2", { teamId: "team-1", role: "impl-1" }),
          ],
          TEAMED,
        ),
        workspace("ws-2", "api", [pane("pane-9")]),
      ]
    : [
        workspace("ws-1", "web", [pane("pane-1"), pane("pane-2")]),
        workspace("ws-2", "api", [pane("pane-9")]),
      ];
  const mail = createMailManager({
    activityOf: () => READY,
    subscribeActivity: () => () => {},
    subscribeChannels: () => () => {},
    wake: () => true,
    now: () => 1_000,
    schedule: () => () => {},
  });
  const registry: CommandRegistry = createCommandRegistry();
  // Applies the roster to the live fixture, the way the deck store would —
  // so a `team.role` followed by a `mail.send` reads what it just wrote.
  // The deck's own transform, in place: the array keeps its identity so the
  // `workspaces` closure below reads what was just written.
  const settle = (
    workspaceId: string,
    teamId: string,
    name: string,
    members: readonly { paneId: string; role: string }[],
  ) => {
    workspaces.splice(
      0,
      workspaces.length,
      ...settleRoster(workspaces, workspaceId, teamId, name, members),
    );
  };
  const dispose = registerMailCommands(registry, {
    mail,
    workspaces: () => workspaces,
    agents: () => [{ id: "claude", label: "Claude" }],
    settleRoster: settle,
  });
  return { registry, mail, dispose, workspaces };
}

async function run(
  registry: CommandRegistry,
  id: string,
  args: CommandArgs,
  source: CommandSource,
) {
  return registry.execute(id, args, source);
}

describe("mail.send", () => {
  it("carries a message to a pane in the caller's own workspace", async () => {
    const { registry, mail } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "question", body: "which port?" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result).toEqual({
      ok: true,
      value: { id: "mail-1", status: "queued", note: expect.any(String) },
    });
    // Nothing is pushed into the pane any more: the message waits in the
    // queue for pane-2 to come and ask.
    const [m] = mail.takeAtTurnEnd("pane-2");
    expect(m.toPaneId).toBe("pane-2");
  });

  it("calls an undelivered message QUEUED, and says it needs nothing", async () => {
    // A boolean was read as failure: shown `delivered: false` for all three
    // teammates, a lead re-sent and then went looking for whether they were
    // alive at all, while three good messages sat in the queue. Queued is
    // the ordinary outcome for a teammate that is not mid-turn.
    const { registry, mail } = setup();
    mail.dispose(); // nothing can land, so the send can only be accepted
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "note", body: "ping" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as { status: string; note: string };
      expect(value.status).toBe("queued");
      expect(value.note).toContain("do not re-send");
    }
  });

  it("refuses a caller it cannot name", async () => {
    // The sender's identity is the reply address, and it is what a `task` is
    // weighed against. Without one there is nothing to answer and no way to
    // ask whose task this is, so the message is refused rather than sent
    // anonymously.
    const { registry, mail } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "note", body: "hello" },
      ANONYMOUS,
    );
    expect(result.ok).toBe(false);
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("cannot reach a pane in another workspace by its id", async () => {
    // Only a team's id crosses a workspace — never a pane's: a pane id is a
    // slot, not an address, and pane-9 is simply not reachable this way.
    const { registry, mail } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-9", kind: "task", body: "do this" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("pane-9");
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("refuses to let a sender forge a delivery report", async () => {
    // `undelivered` is the deck's own word for a fact about the mail system.
    // A sender able to mint one could dress a message as something the host
    // said.
    const { registry, mail } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "undelivered", body: "your message was lost" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("says plainly why a self-addressed message was not sent", async () => {
    const { registry } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-1", kind: "note", body: "hi me" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("itself");
  });
});

describe("mail.inbox", () => {
  it("reads the caller's own mail and takes no argument for whose", async () => {
    const { registry } = setup();
    await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "question", body: "which port?" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    // The receiver sees it...
    const received = await run(registry, "mail.inbox", {}, from("pane-2", "ws-1", "Agent 2"));
    expect(received.ok).toBe(true);
    if (received.ok) {
      const { messages } = received.value as {
        messages: { body: string; from: unknown }[];
      };
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe("which port?");
      expect(messages[0].from).toEqual({
        kind: "pane",
        // On no team there is no role, so the title is the only address
        // there is — and it is the fallback rather than `paneId` because it
        // fails with a refusal instead of reaching an inherited slot.
        address: "Agent 1",
        label: "Agent 1",
        paneId: "pane-1",
      });
    }
    // ...and the sender's own inbox stays empty, with no way to ask for
    // somebody else's.
    const sent = await run(registry, "mail.inbox", {}, from("pane-1", "ws-1", "Agent 1"));
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.value).toMatchObject({ messages: [], waiting: 0 });
  });

  it("names the sender by the ROLE it answers to, not by its pane title", async () => {
    // The receiver replies to whatever it is shown, and only a role is an
    // address. Shown a pane title, an agent sent to the title and was
    // refused — it got through only on a second try after being told the
    // roles.
    const { registry, mail } = setup(true);
    const lead = from("pane-1", "ws-1", "Team structure and the number of direct reports");
    await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "note", body: "ping" },
      lead,
    );
    const [sent] = mail.takeAtTurnEnd("pane-2");
    expect(sent.from).toEqual({
      kind: "pane",
      pane: {
        paneId: "pane-1",
        workspaceId: "ws-1",
        label: "Team structure and the number of direct reports",
        role: "lead",
        // And the team it spoke from: what a receiver on another team is
        // shown the role qualified by.
        team: { id: "team-1", name: "api" },
      },
    });
    // And the READ path says the same. It did not: the message carried the
    // role, while this projection — the one the briefing points an agent at
    // — used to hand back a window title and an opaque id, so a receiver had
    // nothing to put in `to`. Re-read from the journal, because the take
    // above already booked it as read.
    const read = await run(
      registry,
      "mail.inbox",
      { all: true },
      from("pane-2", "ws-1", "Agent 2"),
    );
    expect(read.ok).toBe(true);
    if (read.ok) {
      const { messages } = read.value as {
        messages: { from: { address: string; label: string } }[];
      };
      expect(messages[0].from.address).toBe("lead");
      expect(messages[0].from.label).toBe("Team structure and the number of direct reports");
    }
  });

  it("tells the caller what choosing a kind means, in the tool's own description", async () => {
    // The briefing carries this too, but the briefing is what an agent reads
    // once; the description is what it reads at the moment it is choosing.
    // Both are the same sentence from the same function now — the framing
    // around it was hand-copied at these two sites, and the copy here went
    // on promising an interrupt after delivery stopped reading the kind.
    const { registry } = setup();
    const kind = registry
      .list()
      .find((command) => command.id === "mail.send")
      ?.args?.find((arg) => arg.name === "kind");
    expect(kind?.description).toContain("expect something back");
    expect(kind?.description).toContain("When it lands is not part of the choice");
    expect(kind?.description).not.toContain("interrupt");
  });

  it("refuses a replyTo an agent supplies — the edge is the deck's", async () => {
    // Nothing ever validated it, so an agent could point an answer at any id
    // it liked. It is gone as an argument, and the registry's own refusal of
    // an unknown one is the right answer rather than a silent drop: an agent
    // still carrying the old instruction learns in one round trip, instead
    // of believing it linked a message it did not.
    const { registry, mail } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "answer", body: "done", replyTo: "mail-999" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("gives a host notice no address, because there is nobody to answer", async () => {
    // The deck speaks only to report on delivery. A reply would go nowhere,
    // and the union says so rather than leaving every read site to notice.
    const { registry, mail } = setup();
    mail.announce("pane-2", "note", "your teammate left the team");
    const read = await run(registry, "mail.inbox", {}, from("pane-2", "ws-1", "Agent 2"));
    expect(read.ok).toBe(true);
    if (read.ok) {
      const { messages } = read.value as { messages: { from: unknown }[] };
      expect(messages[0].from).toEqual({ kind: "host" });
    }
  });

  it("refuses a caller it cannot name", async () => {
    const { registry } = setup();
    const result = await run(registry, "mail.inbox", {}, ANONYMOUS);
    expect(result.ok).toBe(false);
  });
});

describe("mail between two teams of one workspace", () => {
  /** api (team-1: pane-1 lead, pane-2 impl-1) and web (team-2) with pane-3
   * as its lead — two leads in one workspace, which is what the bare role
   * could not tell apart. */
  const twoTeams = () => {
    const host = setup(true);
    host.workspaces[0].panes.push(pane("pane-3", { teamId: "team-2", role: "lead" }));
    return host;
  };

  it("reaches another team's member by role@team, shows it the sender as role@team, and a reply copying that comes back", async () => {
    const { registry, mail } = twoTeams();
    const apiLead = from("pane-1", "ws-1", "Agent 1");
    const webLead = from("pane-3", "ws-1", "Agent 3");
    const sent = await run(
      registry,
      "mail.send",
      { to: "lead@web", kind: "question", body: "which port?" },
      apiLead,
    );
    expect(sent.ok).toBe(true);
    const read = await run(registry, "mail.inbox", {}, webLead);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const { messages } = read.value as { messages: { from: { address: string } }[] };
    expect(messages[0].from.address).toBe("lead@team-1");
    const reply = await run(
      registry,
      "mail.send",
      { to: messages[0].from.address, kind: "answer", body: "8080" },
      webLead,
    );
    expect(reply.ok).toBe(true);
    expect(mail.takeAtTurnEnd("pane-1").map((m) => m.toPaneId)).toEqual(["pane-1"]);
  });

  it("shows a teammate as its bare role, and a bare role never crosses into another team", async () => {
    const { registry } = twoTeams();
    const apiLead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "mail.send", { to: "impl-1", kind: "note", body: "hi" }, apiLead);
    const read = await run(registry, "mail.inbox", {}, from("pane-2", "ws-1", "Agent 2"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const { messages } = read.value as { messages: { from: { address: string } }[] };
    expect(messages[0].from.address).toBe("lead");
    // web has no impl-1, and api's is not web's to reach by a bare role.
    const crossed = await run(
      registry,
      "mail.send",
      { to: "impl-1", kind: "note", body: "hi" },
      from("pane-3", "ws-1", "Agent 3"),
    );
    expect(crossed.ok).toBe(false);
  });

  it("shows a teamed sender as role@team to a reader on no team", async () => {
    // A reader outside every team is outside the sender's, so it is shown
    // the form that reaches back — through the command, not only the rule.
    const { registry, workspaces } = twoTeams();
    workspaces[0].panes.push(pane("pane-4"));
    await run(
      registry,
      "mail.send",
      { to: "pane-4", kind: "note", body: "hi" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    const read = await run(registry, "mail.inbox", {}, from("pane-4", "ws-1", "Agent 4"));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const { messages } = read.value as { messages: { from: { address: string } }[] };
    expect(messages[0].from.address).toBe("lead@team-1");
  });

  it("a reply copying the shown address reaches the sender even after its team was renamed", async () => {
    const { registry, mail, workspaces } = twoTeams();
    await run(registry, "mail.send", { to: "lead@web", kind: "question", body: "which port?" }, from("pane-1", "ws-1", "Agent 1"));
    const read = await run(registry, "mail.inbox", {}, from("pane-3", "ws-1", "Agent 3"));
    if (!read.ok) throw new Error("inbox refused");
    const { messages } = read.value as { messages: { from: { address: string } }[] };
    // api is renamed between the question and the answer.
    workspaces[0].teams = workspaces[0].teams!.map((t) => (t.id === "team-1" ? { ...t, name: "backend" } : t));
    const reply = await run(registry, "mail.send", { to: messages[0].from.address, kind: "answer", body: "8080" }, from("pane-3", "ws-1", "Agent 3"));
    expect(reply.ok).toBe(true);
    expect(mail.takeAtTurnEnd("pane-1").map((m) => m.toPaneId)).toEqual(["pane-1"]);
  });

  it("takes back a message to another team by the same address", async () => {
    const { registry } = twoTeams();
    const apiLead = from("pane-1", "ws-1", "Agent 1");
    const sent = await run(
      registry,
      "mail.send",
      { to: "lead@web", kind: "note", body: "never mind" },
      apiLead,
    );
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const { id } = sent.value as { id: string };
    const cancelled = await run(registry, "mail.cancel", { id, to: "lead@web" }, apiLead);
    expect(cancelled.ok && cancelled.value).toMatchObject({ status: "cancelled" });
  });
});

describe("team.role", () => {
  // Every case runs on a workspace where api (team-1) already holds pane-1
  // as lead and pane-2 as impl-1: a team is born empty (team.create) and
  // takes agents by team.add, never by this command, which only settles a
  // role on the caller's own team.
  it("changes a teammate's role by its old address, and a teammate reaches it by the new one", async () => {
    const { registry, mail, workspaces } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const reroled = await run(registry, "team.role", { agent: "impl-1", role: "impl-2" }, lead);
    expect(reroled.ok && reroled.value).toEqual({
      paneId: "pane-2",
      team: { id: "team-1", name: "api", role: "impl-2" },
    });
    expect(workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-2" });
    mail.takeAtTurnEnd("pane-2");
    // The address a lead can actually be told to use.
    const sent = await run(
      registry,
      "mail.send",
      { to: "impl-2", kind: "task", body: "take the parser" },
      lead,
    );
    expect(sent.ok).toBe(true);
    const [m] = mail.takeAtTurnEnd("pane-2");
    expect(m.toPaneId).toBe("pane-2");
  });

  it("takes a pane title or id as well as a role", async () => {
    const { registry, workspaces } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const byId = await run(registry, "team.role", { agent: "pane-2", role: "impl-3" }, lead);
    expect(byId.ok).toBe(true);
    expect(workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-3" });
  });

  it("refuses a role another member already answers to", async () => {
    const { registry } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const clash = await run(registry, "team.role", { agent: "pane-2", role: "lead" }, lead);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.message).toContain("a role is an address");
  });

  it("records the role that changed, and briefs nobody from here", async () => {
    // Recording the role alone once built teams whose members never learned
    // they were on one, and this command briefed them itself to close that.
    // It was the second of two producers, reading the roster from the plan
    // because the deck "might not have caught up" — and the first, the
    // roster dialog, was deleted with its call. The briefing now follows
    // MEMBERSHIP off the deck (`membershipWatch`), for this door and every
    // other; the command's whole job is the roster write.
    const { registry, mail, workspaces } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.role", { agent: "pane-2", role: "impl-2" }, lead);

    expect(workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-2" });
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
    expect(mail.takeAtTurnEnd("pane-1")).toEqual([]);
  });

  it("refuses a blank role rather than settling nothing", async () => {
    // The registry accepts "" for a required string; a member with no
    // address is one no teammate can reach, so the blank is refused in words
    // — an agent cannot see a silent no-op and keeps building on it.
    const { registry, mail, workspaces } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const blank = await run(registry, "team.role", { agent: "pane-2", role: "  " }, lead);
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error.message).toContain("needs a role");
    expect(workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-1" });
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("refuses to leave a team without the member that hands out work", async () => {
    // The same rule the dialog obeys, on the path an agent drives. Without
    // it, `team.role` could build a leaderless team — one where sendRefusal
    // then refuses every task with nobody able to explain why.
    const { registry } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const headless = await run(registry, "team.role", { agent: "pane-1", role: "impl-2" }, lead);
    expect(headless.ok).toBe(false);
    if (!headless.ok) expect(headless.error.message).toContain("lead");
  });

  it("reaches only the caller's own team — a member of another team is refused by name", async () => {
    // A role is an address inside one team. Two teams share this workspace;
    // the lead of api may not rename what web's members are called, and the
    // refusal says whose the member is rather than pretending it is nowhere.
    const { registry, workspaces } = setup(true);
    workspaces[0].panes.push(pane("pane-3", { teamId: "team-2", role: "lead" }));
    const lead = from("pane-1", "ws-1", "Agent 1");
    const foreign = await run(registry, "team.role", { agent: "pane-3", role: "impl-1" }, lead);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.error.message).toContain('on team "web"');
      expect(foreign.error.message).toContain('not on "api"');
    }
    expect(workspaces[0].panes[2].team).toEqual({ teamId: "team-2", role: "lead" });
  });

  it("takes the role@team spelling for its own team only", async () => {
    // The resolver reads the spelling for any team; the same-team check is
    // what keeps this tool inside the caller's own.
    const { registry, workspaces } = setup(true);
    workspaces[0].panes.push(pane("pane-3", { teamId: "team-2", role: "lead" }));
    const lead = from("pane-1", "ws-1", "Agent 1");
    const own = await run(registry, "team.role", { agent: "impl-1@api", role: "impl-2" }, lead);
    expect(own.ok).toBe(true);
    expect(workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-2" });
    const foreign = await run(registry, "team.role", { agent: "lead@web", role: "impl-1" }, lead);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.error.message).toContain('on team "web"');
    expect(workspaces[0].panes[2].team).toEqual({ teamId: "team-2", role: "lead" });
  });

  it("refuses a caller on no team, which has no roster to change", async () => {
    const { registry } = setup(true);
    const alone = await run(
      registry,
      "team.role",
      { agent: "pane-9", role: "lead" },
      from("pane-9", "ws-2", "Agent 9"),
    );
    expect(alone.ok).toBe(false);
    if (!alone.ok) expect(alone.error.message).toContain("on no team");
  });

  it("cannot reach a pane in another workspace", async () => {
    // The same boundary the messages themselves obey.
    const { registry } = setup(true);
    const result = await run(
      registry,
      "team.role",
      { agent: "pane-9", role: "impl-2" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
  });

  it("keeps every role reachable through a rename — the name is an address, not a key", async () => {
    // The roster is held by team id: renaming the team touches no pane, and
    // a teammate addressed by role a moment later is still found.
    const { registry, workspaces, mail } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    workspaces.splice(0, workspaces.length, ...renameTeam(workspaces, "ws-1", "team-1", "platform"));
    expect(workspaces[0].panes.map((pane) => pane.team)).toEqual([
      { teamId: "team-1", role: "lead" },
      { teamId: "team-1", role: "impl-1" },
    ]);

    const sent = await run(
      registry,
      "mail.send",
      { to: "impl-1", kind: "task", body: "still you" },
      lead,
    );
    expect(sent.ok).toBe(true);
    expect(mail.takeAtTurnEnd("pane-2").map((message) => message.toPaneId)).toEqual(["pane-2"]);
    // And a role settled under the new name lands on the same team.
    const reroled = await run(registry, "team.role", { agent: "pane-2", role: "impl-2" }, lead);
    expect(reroled.ok && reroled.value).toMatchObject({ team: { id: "team-1", name: "platform" } });
  });
});

describe("registerMailCommands", () => {
  it("takes every command away again, so they stop being MCP tools", () => {
    const { registry, dispose } = setup();
    for (const id of ["mail.send", "mail.inbox", "team.role"]) {
      expect(registry.has(id)).toBe(true);
    }
    dispose();
    for (const id of ["mail.send", "mail.inbox", "team.role"]) {
      expect(registry.has(id)).toBe(false);
    }
  });
});

describe("mail.cancel", () => {
  /** Send one message and hand back the id the tool answered with. */
  async function sent(registry: CommandRegistry, body = "ship it") {
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "task", body },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(true);
    return result.ok ? (result.value as { id: string }).id : "";
  }

  it("takes back a message nobody has come for", async () => {
    const { registry, mail } = setup();
    const id = await sent(registry);
    const result = await run(
      registry,
      "mail.cancel",
      { id, to: "pane-2" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result).toEqual({
      ok: true,
      value: { status: "cancelled", note: expect.any(String) },
    });
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("says too-late once the recipient has read it", async () => {
    const { registry, mail } = setup();
    const id = await sent(registry);
    mail.inbox("pane-2");
    const result = await run(
      registry,
      "mail.cancel",
      { id, to: "pane-2" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ status: "too-late" });
  });

  it("names a role as what it is, rather than calling it a missing message", async () => {
    // Every other mail argument is an address, so this is the likeliest slip.
    // Telling the agent "no such message" would send it hunting for the wrong
    // problem entirely.
    const { registry } = setup();
    await sent(registry);
    const result = await run(
      registry,
      "mail.cancel",
      { id: "impl-1", to: "pane-2" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("is not a message id");
  });

  it("answers a borrowed id exactly as it answers one that never existed", async () => {
    // The whole point of merging those refusals. If somebody else's id read
    // differently from a made-up one, an agent could walk the ids until the
    // wording changed and count a conversation it never saw.
    const { registry } = setup();
    const real = await sent(registry);
    const borrowed = await run(
      registry,
      "mail.cancel",
      { id: real, to: "pane-1" },
      from("pane-2", "ws-1", "Agent 2"),
    );
    const invented = await run(
      registry,
      "mail.cancel",
      { id: "mail-999", to: "pane-1" },
      from("pane-2", "ws-1", "Agent 2"),
    );
    expect(borrowed.ok).toBe(false);
    expect(invented.ok).toBe(false);
    if (!borrowed.ok && !invented.ok) {
      expect(borrowed.error.message).toBe(
        invented.error.message.replace("mail-999", real),
      );
    }
  });

  it("refuses an address that reaches nobody before it looks at the route", async () => {
    // Step three, and it is reached only because the id already proved to be
    // the caller's — so the answer says something about the caller's own
    // address book and nothing about anyone else's traffic.
    const { registry, mail } = setup();
    const id = await sent(registry);
    const result = await run(
      registry,
      "mail.cancel",
      { id, to: "impl-9" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("impl-9");
    expect(mail.takeAtTurnEnd("pane-2")).toHaveLength(1);
  });

  it("refuses when the recipient named is not the one it went to", async () => {
    // The confirmation earns its place here: a mistyped id would otherwise
    // reach into a message the caller never meant to touch. Its own traffic,
    // so this refusal may be plain.
    const { registry, mail } = setup();
    const id = await sent(registry);
    const result = await run(
      registry,
      "mail.cancel",
      { id, to: "pane-1" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("went somewhere else");
    // And the message is untouched.
    expect(mail.takeAtTurnEnd("pane-2")).toHaveLength(1);
  });
});

describe("mail between workspaces", () => {
  /** Two projects: ws-1 holds api (team-1, lead pane-1) and a stray pane-7
   * on no team; ws-2 holds team-x (lead pane-9) — and a team NAMED "api"
   * too (team-y, lead pane-8), the collision a name-shown reply fell into. */
  const projects = () => {
    const workspaces = [
      workspace(
        "ws-1",
        "keepdeck",
        [pane("pane-1", { teamId: "team-1", role: "lead" }), pane("pane-7")],
        [{ id: "team-1", name: "api", location: { kind: "attached", cwd: "/a" } }],
      ),
      workspace(
        "ws-2",
        "mocha",
        [pane("pane-9", { teamId: "team-x", role: "lead" }), pane("pane-8", { teamId: "team-y", role: "lead" })],
        [
          { id: "team-x", name: "android", location: { kind: "attached", cwd: "/m" } },
          { id: "team-y", name: "api", location: { kind: "attached", cwd: "/n" } },
        ],
      ),
    ];
    const mail = createMailManager({
      activityOf: () => READY,
      subscribeActivity: () => () => {},
      subscribeChannels: () => () => {},
      wake: () => true,
      now: () => 1_000,
      schedule: () => () => {},
    });
    const registry: CommandRegistry = createCommandRegistry();
    registerMailCommands(registry, {
      mail,
      workspaces: () => workspaces,
      agents: () => [{ id: "claude", label: "Claude" }],
      settleRoster: () => {},
    });
    return { registry, mail };
  };
  const keepdeckLead = from("pane-1", "ws-1", "Agent 1");
  const mochaLead = from("pane-9", "ws-2", "Agent 9");

  it("a lead reaches another project's lead by role@<team id>, and a reply copying the shown address comes back — not to a same-named team there", async () => {
    const { registry, mail } = projects();
    const sent = await run(registry, "mail.send", { to: "lead@team-x", kind: "task", body: "feedback: three problems" }, keepdeckLead);
    expect(sent.ok).toBe(true);
    const read = await run(registry, "mail.inbox", {}, mochaLead);
    if (!read.ok) throw new Error("inbox refused");
    const { messages } = read.value as { messages: { kind: string; from: { address: string } }[] };
    expect(messages[0]).toMatchObject({ kind: "task", from: { address: "lead@team-1" } });
    // ws-2 has its own team named "api": a reply to "lead@api" would have
    // reached pane-8. The id reaches the sender.
    const reply = await run(registry, "mail.send", { to: messages[0].from.address, kind: "answer", body: "on it" }, mochaLead);
    expect(reply.ok).toBe(true);
    expect(mail.takeAtTurnEnd("pane-1").map((m) => m.kind)).toEqual(["answer"]);
    expect(mail.takeAtTurnEnd("pane-8")).toEqual([]);
  });

  it("a team NAME never crosses: it means the sender's own workspace, where no such team is", async () => {
    const { registry, mail } = projects();
    const result = await run(registry, "mail.send", { to: "lead@android", kind: "note", body: "hi" }, keepdeckLead);
    expect(result.ok).toBe(false);
    expect(mail.takeAtTurnEnd("pane-9")).toEqual([]);
  });

  it("a sender on no team cannot write across — nobody there could answer it", async () => {
    const { registry, mail } = projects();
    const result = await run(registry, "mail.send", { to: "lead@team-x", kind: "note", body: "hi" }, from("pane-7", "ws-1", "Agent 7"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("on no team");
    expect(mail.takeAtTurnEnd("pane-9")).toEqual([]);
  });

  it("takes back a message sent across by the same address", async () => {
    const { registry } = projects();
    const sent = await run(registry, "mail.send", { to: "lead@team-x", kind: "note", body: "draft" }, keepdeckLead);
    if (!sent.ok) throw new Error("send refused");
    const { id } = sent.value as { id: string };
    const cancelled = await run(registry, "mail.cancel", { id, to: "lead@team-x" }, keepdeckLead);
    expect(cancelled.ok).toBe(true);
  });

  it("team.role never leaves the caller's workspace, even by a team id", async () => {
    const { registry } = projects();
    const result = await run(registry, "team.role", { agent: "lead@team-x", role: "impl-1" }, keepdeckLead);
    expect(result.ok).toBe(false);
  });
});
