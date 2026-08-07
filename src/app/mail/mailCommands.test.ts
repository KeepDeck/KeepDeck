import { describe, expect, it } from "vitest";
import {
  createCommandRegistry,
  type CommandArgs,
  type CommandRegistry,
  type CommandSource,
} from "../../domain/commands";
import type { Pane, Workspace } from "../../domain/deck";
import type { Mail } from "../../domain/mail";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { PaneActivity } from "../../domain/status";
import type { Deck } from "../useDeck";
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
  const delivered: Mail[] = [];
  const mail = createMailManager({
    activityOf: () => READY,
    subscribeActivity: () => () => {},
    subscribeChannels: () => () => {},
    deliver: (message) => {
      delivered.push(message);
      return true;
    },
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
    deck: () => ({ workspaces }) as unknown as Deck,
    agents: () => [{ id: "claude", label: "Claude" }],
    setPaneTeam,
  });
  return { registry, mail, delivered, dispose, workspaces };
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
    const { registry, delivered } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "question", body: "which port?" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result).toEqual({ ok: true, value: { id: "mail-1", delivered: true } });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].toPaneId).toBe("pane-2");
  });

  it("refuses a caller it cannot name", async () => {
    // The sender's identity is the reply address and the only thing bounding
    // a chain. Without one there is nothing to answer and nothing to charge
    // the hop against, so the message is refused rather than sent anonymously.
    const { registry, delivered } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "note", body: "hello" },
      ANONYMOUS,
    );
    expect(result.ok).toBe(false);
    expect(delivered).toHaveLength(0);
  });

  it("cannot reach a pane in another workspace", async () => {
    // The workspace is the feature's hard boundary, and with no permission
    // gate in the registry yet, this resolution IS the boundary. pane-9
    // exists — it is simply not the caller's business.
    const { registry, delivered } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-9", kind: "task", body: "do this" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("pane-9");
    expect(delivered).toHaveLength(0);
  });

  it("refuses to let a sender forge a delivery report", async () => {
    // `undelivered` is the deck's own word for a fact about the mail system.
    // A sender able to mint one could dress a message as something the host
    // said.
    const { registry, delivered } = setup();
    const result = await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "undelivered", body: "your message was lost" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    expect(result.ok).toBe(false);
    expect(delivered).toHaveLength(0);
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
      const messages = received.value as { body: string; from: unknown }[];
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe("which port?");
      expect(messages[0].from).toEqual({
        kind: "pane",
        label: "Agent 1",
        paneId: "pane-1",
      });
    }
    // ...and the sender's own inbox stays empty, with no way to ask for
    // somebody else's.
    const sent = await run(registry, "mail.inbox", {}, from("pane-1", "ws-1", "Agent 1"));
    expect(sent.ok).toBe(true);
    if (sent.ok) expect(sent.value).toEqual([]);
  });

  it("keeps the hop counter off the wire", async () => {
    // It bounds the conversation. An agent that could read it could try to
    // reason its way around it, and it answers no question an agent has.
    const { registry } = setup();
    await run(
      registry,
      "mail.send",
      { to: "pane-2", kind: "note", body: "one" },
      from("pane-1", "ws-1", "Agent 1"),
    );
    const read = await run(registry, "mail.inbox", {}, from("pane-2", "ws-1", "Agent 2"));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).not.toHaveProperty("0.hop");
  });

  it("refuses a caller it cannot name", async () => {
    const { registry } = setup();
    const result = await run(registry, "mail.inbox", {}, ANONYMOUS);
    expect(result.ok).toBe(false);
  });
});

describe("team.assign", () => {
  it("puts an agent on a team, and lets a teammate address it by role", async () => {
    const { registry, delivered } = setup();
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
    expect(delivered[0].toPaneId).toBe("pane-2");
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
    if (!clash.ok) expect(clash.error.message).toContain("already taken");
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

  it("takes an agent off its team when neither field is given", async () => {
    const { registry, workspaces } = setup();
    const lead = from("pane-1", "ws-1", "Agent 1");
    await run(registry, "team.assign", { agent: "pane-2", team: "api", role: "impl-1" }, lead);
    expect(workspaces[0].panes[1].team).toBeDefined();
    await run(registry, "team.assign", { agent: "pane-2" }, lead);
    expect(workspaces[0].panes[1].team).toBeUndefined();
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
