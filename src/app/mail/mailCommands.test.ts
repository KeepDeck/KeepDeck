import { describe, expect, it } from "vitest";
import {
  createCommandRegistry,
  type CommandArgs,
  type CommandRegistry,
  type CommandSource,
} from "../../domain/commands";
import type { Pane, Workspace } from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { PaneActivity } from "../../domain/status";
import { registerMailCommands } from "./mailCommands";
import { createMailManager } from "./mailManager";

const READY: PaneActivity = { state: "done", at: 1, interrupted: false };

const pane = (id: string): Pane => ({ id, agentType: "claude" });

const workspace = (id: string, name: string, panes: Pane[]): Workspace =>
  ({
    id,
    instance: createWorkspaceInstance(),
    name,
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  }) as Workspace;

/** A caller identified as a pane, the way the MCP transport mints it. */
function from(paneId: string, workspaceId: string, label: string): CommandSource {
  return {
    kind: "external",
    client: "mcp",
    pane: { id: paneId, workspaceId, label },
  };
}

const ANONYMOUS: CommandSource = { kind: "external", client: "mcp" };

function setup() {
  const workspaces = [
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
  // Applies the assignment to the live fixture, the way the deck store would
  // — so a `team.assign` followed by a `mail.send` reads what it just wrote.
  const setPaneTeam = (
    workspaceId: string,
    paneId: string,
    team: { name: string; role: string } | null,
  ) => {
    const target = workspaces
      .find((ws) => ws.id === workspaceId)
      ?.panes.find((p) => p.id === paneId);
    if (target) {
      if (team) target.team = team;
      else delete target.team;
    }
  };
  const dispose = registerMailCommands(registry, {
    mail,
    workspaces: () => workspaces,
    agents: () => [{ id: "claude", label: "Claude" }],
    setPaneTeam,
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
    const { registry, workspaces, mail } = setup();
    const lead = from("pane-1", "ws-1", "Структура команды и количество подчинённых");
    workspaces[0].panes[0].team = { name: "test", role: "lead" };
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
        label: "Структура команды и количество подчинённых",
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
      expect(messages[0].from.label).toBe("Структура команды и количество подчинённых");
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
  it("puts an agent on a team, and lets a teammate address it by role", async () => {
    const { registry, mail } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.assign", { agent: "pane-1", team: "api", role: "lead" }, lead);
    await run(registry, "team.assign", { agent: "pane-2", team: "api", role: "impl-1" }, lead);
    // The address a lead can actually be told to use.
    const sent = await run(
      registry,
      "mail.send",
      { to: "impl-1", kind: "task", body: "take the parser" },
      lead,
    );
    expect(sent.ok).toBe(true);
    const [m] = mail.takeAtTurnEnd("pane-2");
    expect(m.toPaneId).toBe("pane-2");
  });

  it("refuses a role another pane already answers to", async () => {
    const { registry } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.assign", { agent: "pane-1", team: "api", role: "lead" }, lead);
    const clash = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "api", role: "lead" },
      lead,
    );
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.message).toContain("a role is an address");
  });

  it("briefs the agent it puts on a team, and re-briefs the ones already on it", async () => {
    // The finding this whole path was rebuilt for. Recording the role alone
    // built teams whose members never learned they were on one: they held an
    // address nobody had told them about, and nothing would tell them until a
    // fresh session happened to restate it.
    const { registry, mail } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.assign", { agent: "pane-1", team: "api", role: "lead" }, lead);
    await run(registry, "team.assign", { agent: "pane-2", team: "api", role: "impl-1" }, lead);

    const joiner = mail.takeAtTurnEnd("pane-2");
    expect(joiner.map((message) => message.kind)).toEqual(["team"]);
    expect(joiner[0].body).toContain("impl-1");
    // And the lead hears the roster it now leads — its first brief named
    // only itself. One message, not two: standing context supersedes itself,
    // so what waits is always the current roster and never a history of it.
    const leadBriefs = mail.takeAtTurnEnd("pane-1");
    expect(leadBriefs).toHaveLength(1);
    expect(leadBriefs[0].body).toContain("impl-1");
  });

  it("handles each field arriving without the other", async () => {
    // Three shapes an agent will produce, and none of them may end in a
    // silent no-op: an agent cannot see that nothing happened, so it keeps
    // building on a team that does not exist.
    const { registry, mail } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");

    // A role with no team, for a pane on NO team: refused. It used to answer
    // "done, team: null" while doing nothing whatsoever.
    const nowhere = await run(registry, "team.assign", { agent: "pane-2", role: "impl-3" }, lead);
    expect(nowhere.ok).toBe(false);
    if (!nowhere.ok) expect(nowhere.error.message).toContain("not on a team");

    await run(registry, "team.assign", { agent: "pane-1", team: "api", role: "lead" }, lead);

    // A team with no role: refused, because a member with no address is one
    // no teammate can reach.
    const nameless = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "api" },
      lead,
    );
    expect(nameless.ok).toBe(false);

    // A role with no team, for a pane that is on one: settles onto the team
    // it already holds. The obvious reading, and the only one that does
    // anything.
    await run(registry, "team.assign", { agent: "pane-2", team: "api", role: "impl-1" }, lead);
    mail.takeAtTurnEnd("pane-2");
    const rerole = await run(registry, "team.assign", { agent: "pane-2", role: "impl-2" }, lead);
    expect(rerole.ok && rerole.value).toEqual({
      paneId: "pane-2",
      team: { name: "api", role: "impl-2" },
    });
    // And it is TOLD, like any other roster change.
    expect(mail.takeAtTurnEnd("pane-2")[0]?.body).toContain("impl-2");
  });

  it("refuses to leave a team without the member that hands out work", async () => {
    // The same rule the dialog obeys, on the path an agent drives. Without
    // it, `team.assign` could build a leaderless team — one where sendRefusal
    // then refuses every task with nobody able to explain why.
    const { registry } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");
    const headless = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "api", role: "impl-1" },
      lead,
    );
    expect(headless.ok).toBe(false);
    if (!headless.ok) expect(headless.error.message).toContain("lead");
  });

  it("refuses to take a pane that is already on another team", async () => {
    const { registry } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.assign", { agent: "pane-1", team: "api", role: "lead" }, lead);
    await run(registry, "team.assign", { agent: "pane-2", team: "api", role: "impl-1" }, lead);
    const poach = await run(
      registry,
      "team.assign",
      { agent: "pane-2", team: "web", role: "lead" },
      lead,
    );
    expect(poach.ok).toBe(false);
    if (!poach.ok) expect(poach.error.message).toContain("api");
  });

  it("cannot put a pane from another workspace on a team", async () => {
    // The same boundary the messages themselves obey.
    const { registry } = setup();
    const result = await run(
      registry,
      "team.assign",
      { agent: "pane-9", team: "api", role: "impl-2" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
  });

  it("takes an agent off its team when neither field is given, and says so", async () => {
    const { registry, workspaces, mail } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.assign", { agent: "pane-1", team: "api", role: "lead" }, lead);
    await run(registry, "team.assign", { agent: "pane-2", team: "api", role: "impl-1" }, lead);
    expect(workspaces[0].panes[1].team).toBeDefined();
    mail.takeAtTurnEnd("pane-2");

    await run(registry, "team.assign", { agent: "pane-2" }, lead);
    expect(workspaces[0].panes[1].team).toBeUndefined();
    // Told once, so it stops addressing roles that no longer reach anyone.
    const farewell = mail.takeAtTurnEnd("pane-2");
    expect(farewell.map((message) => message.kind)).toEqual(["team"]);
    expect(farewell[0].body).toContain("api");
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
