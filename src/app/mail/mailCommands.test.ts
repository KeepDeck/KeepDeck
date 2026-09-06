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
  // so a `team.assign` followed by a `mail.send` reads what it just wrote.
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

  it("cannot reach a pane in another workspace", async () => {
    // The workspace is the feature's hard boundary, and with no permission
    // gate in the registry yet, this resolution IS the boundary. pane-9
    // exists — it is simply not the caller's business.
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

describe("team.assign", () => {
  // Every case runs on a workspace where api (team-1) already holds pane-1
  // as lead and pane-2 as impl-1: a team is born empty (team.create) and
  // takes agents by team.add, never by this command, which only settles a role on the
  // team the agent is already on.
  it("changes an agent's role on its own team, and a teammate reaches it by the new address", async () => {
    const { registry, mail, workspaces } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const reroled = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "api", role: "impl-2" },
      lead,
    );
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

  it("names the team by name however cased, or by id — and only the agent's own", async () => {
    const { registry } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    for (const ref of [" API ", "team-1", undefined]) {
      const result = await run(
        registry,
        "team.assign",
        { agent: "pane-2", ...(ref !== undefined && { team: ref }), role: "impl-3" },
        lead,
      );
      expect(result.ok, String(ref)).toBe(true);
    }
    // A team that is not here is not made here.
    const nowhere = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "docs", role: "impl-1" },
      lead,
    );
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.error.message).toContain("team.create");
  });

  it("refuses a role another member already answers to", async () => {
    const { registry } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const clash = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "api", role: "lead" },
      lead,
    );
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.message).toContain("a role is an address");
  });

  it("briefs the agent whose role changed, and re-briefs the rest of the roster", async () => {
    // Recording the role alone built teams whose members never learned they
    // were on one: they held an address nobody had told them about, and
    // nothing would tell them until a fresh session happened to restate it.
    const { registry, mail } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.assign", { agent: "pane-2", role: "impl-2" }, lead);

    const reroled = mail.takeAtTurnEnd("pane-2");
    expect(reroled.map((message) => message.kind)).toEqual(["team"]);
    expect(reroled[0].body).toContain('as "impl-2"');
    // And the lead hears the roster it now leads. One message, not two:
    // standing context supersedes itself, so what waits is always the
    // current roster and never a history of it.
    const leadBriefs = mail.takeAtTurnEnd("pane-1");
    expect(leadBriefs).toHaveLength(1);
    expect(leadBriefs[0].body).toContain("impl-2");
    expect(leadBriefs[0].body).not.toContain("impl-1");
  });

  it("refuses a member with no role, and an agent asked for nothing", async () => {
    // Neither may end in a silent no-op: an agent cannot see that nothing
    // happened, so it keeps building on a change that was never made.
    const { registry, mail, workspaces } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const nameless = await run(registry, "team.assign", { agent: "pane-2", team: "api" }, lead);
    expect(nameless.ok).toBe(false);
    if (!nameless.ok) expect(nameless.error.message).toContain("role");

    const nothing = await run(registry, "team.assign", { agent: "pane-2" }, lead);
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.error.message).toContain("team.add");
    expect(workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-1" });
    expect(mail.takeAtTurnEnd("pane-2")).toEqual([]);
  });

  it("refuses to leave a team without the member that hands out work", async () => {
    // The same rule the dialog obeys, on the path an agent drives. Without
    // it, `team.assign` could build a leaderless team — one where sendRefusal
    // then refuses every task with nobody able to explain why.
    const { registry } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const headless = await run(
      registry,
      "team.assign",
      { agent: "pane-1", role: "impl-2" },
      lead,
    );
    expect(headless.ok).toBe(false);
    if (!headless.ok) expect(headless.error.message).toContain("lead");
  });

  it("refuses to move an agent to another team, and says how work moves instead", async () => {
    // An agent runs where its team runs: moving work between teams is
    // starting an agent on the target team.
    const { registry, workspaces } = setup(true);
    const lead = from("pane-1", "ws-1", "Agent 1");
    const moved = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "web", role: "lead" },
      lead,
    );
    expect(moved.ok).toBe(false);
    if (!moved.ok) {
      expect(moved.error.message).toContain('"api"');
      expect(moved.error.message).toContain("team.add");
    }
    expect(workspaces[0].panes[1].team).toEqual({ teamId: "team-1", role: "impl-1" });
  });

  it("cannot reach a pane in another workspace", async () => {
    // The same boundary the messages themselves obey.
    const { registry } = setup(true);
    const result = await run(
      registry,
      "team.assign",
      { agent: "pane-9", team: "api", role: "impl-2" },
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
    const reroled = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "platform", role: "impl-2" },
      lead,
    );
    expect(reroled.ok && reroled.value).toMatchObject({ team: { id: "team-1", name: "platform" } });
  });
});

describe("registerMailCommands", () => {
  it("takes every command away again, so they stop being MCP tools", () => {
    const { registry, dispose } = setup();
    for (const id of ["mail.send", "mail.inbox", "team.assign"]) {
      expect(registry.has(id)).toBe(true);
    }
    dispose();
    for (const id of ["mail.send", "mail.inbox", "team.assign"]) {
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
