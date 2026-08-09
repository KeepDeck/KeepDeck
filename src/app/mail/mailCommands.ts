/**
 * `mail.send` and `mail.inbox` — the two commands an agent uses to reach
 * another agent, and therefore the two MCP tools it sees.
 *
 * Registered by `createMailService` rather than with the core set, because
 * they must come and go with the feature's toggle: a registered command is
 * an MCP tool, and one that exists only to refuse advertises a capability
 * the deck has switched off.
 *
 * Both commands read WHO IS CALLING and refuse anyone they cannot name.
 * That is not a formality — the sender's identity is the reply address, the
 * only thing bounding a chain, and the only answer to "whose inbox is this".
 */
import {
  resolvePaneRef,
  type CommandArgs,
  type CommandRegistry,
  type CommandSource,
} from "../../domain/commands";
import { findWorkspaceOfPane, type Pane, type Workspace } from "../../domain/deck";
import {
  planTeam,
  teamMembers,
  leadRole,
  resolveMailTarget,
  senderOf,
  teamRoles,
  type Mail,
  type MailKind,
  type MailSender,
  type SendRefusal,
} from "../../domain/mail";
import type { Deck } from "../useDeck";
import { log } from "../../ipc/log";
import type { MailManager } from "./mailManager";
import { applyTeamPlan, type TeamSetupDeps } from "./teamSetup";

export interface MailCommandDeps {
  mail: MailManager;
  deck(): Deck;
  /** Just enough to name a pane the way its header does. */
  agents(): readonly { id: string; label: string }[];
  /** Put a pane on a team, or take it off one. */
  setPaneTeam(
    workspaceId: string,
    paneId: string,
    team: { name: string; role: string } | null,
  ): void;
}

/**
 * What applying a roster means, from here.
 *
 * The same owner the dialog goes through (`applyTeamPlan`), with the ports an
 * AGENT-driven settle can honestly supply: it records the roles, briefs the
 * joiner, re-briefs whoever's roster changed and tells whoever left. It
 * cannot start or end an agent — a roster settle asks for neither, and a plan
 * that did would say so rather than skip it silently.
 */
function rosterPorts(deps: MailCommandDeps): TeamSetupDeps {
  return {
    setPaneTeam: deps.setPaneTeam,
    // Always live here: these commands exist only while the feature is on.
    announce: (paneId, kind, body) => deps.mail.announce(paneId, kind, body),
    report: (title, message) => log.warn("web:mail", `${title}: ${message}`),
  };
}

/** The workspace a caller belongs to, refusing anyone who belongs to none.
 * Every command here starts with this: the caller's workspace is both who
 * they are and how far they can reach. */
function callerWorkspace(
  deps: MailCommandDeps,
  sender: MailSender,
): { workspace: Workspace; pane: Pane } {
  const workspace = findWorkspaceOfPane(deps.deck().workspaces, sender.paneId);
  const pane = workspace?.panes.find((p) => p.id === sender.paneId);
  if (!workspace || !pane) throw new Error(NOT_AN_AGENT_MESSAGE);
  return { workspace, pane };
}

/** What an agent may put in `kind`. `undelivered` is missing on purpose: it
 * is the deck's own word for a delivery report, and a sender able to forge
 * one could dress a message as a fact about the mail system. */
const SENDABLE_KINDS: MailKind[] = ["task", "question", "answer", "note"];

const NOT_AN_AGENT_MESSAGE =
  "only an agent pane can use mail — this connection is not attached to one";

function requireSender(source: CommandSource): MailSender {
  const sender = senderOf(source);
  if (!sender) throw new Error(NOT_AN_AGENT_MESSAGE);
  return sender;
}

function str(args: CommandArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** One message as the calling agent sees it. `hop` stays inside — it bounds
 * the conversation and is not the agent's business, and an agent that could
 * read it could try to reason its way around the bound. */
function wire(mail: Mail) {
  return {
    id: mail.id,
    kind: mail.kind,
    body: mail.body,
    at: mail.at,
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    from:
      mail.from.kind === "host"
        ? { kind: "host" as const }
        : {
            kind: "pane" as const,
            label: mail.from.pane.label,
            paneId: mail.from.pane.paneId,
          },
  };
}

export function registerMailCommands(
  registry: CommandRegistry,
  deps: MailCommandDeps,
): () => void {
  const disposers = [
    registry.register({
      id: "mail.send",
      title:
        "Send a message to another agent. Answers status: delivered, or queued — queued means accepted and waiting for the recipient's next turn boundary, which is normal and needs nothing from you",
      args: [
        {
          name: "to",
          type: "string",
          required: true,
          description: "Recipient agent pane title, name, or id — in your own workspace",
        },
        {
          name: "kind",
          type: "string",
          required: true,
          description: `What this is: ${SENDABLE_KINDS.join(", ")}`,
        },
        { name: "body", type: "string", required: true, description: "The message" },
        {
          name: "replyTo",
          type: "string",
          description: "Id of the message this answers, when it answers one",
        },
      ],
      run: (args, source) => {
        const from = requireSender(source);
        const kind = str(args, "kind");
        if (!kind || !SENDABLE_KINDS.includes(kind as MailKind)) {
          throw new Error(
            `unknown mail kind ${JSON.stringify(String(args.kind))} — expected one of ${SENDABLE_KINDS.join(", ")}`,
          );
        }
        // The sender's OWN workspace, and nothing else, is where a recipient
        // may be named. The workspace is the feature's hard boundary: an
        // agent has no business reaching into a piece of work it is not part
        // of, and with no permission gate anywhere in the registry yet, this
        // resolution IS the boundary rather than a convenience.
        const { workspace, pane } = callerWorkspace(deps, from);
        // Stamp the ROLE the sender answers to. The receiver replies to
        // whatever it is shown as the sender, so showing anything that is
        // not an address is showing it a dead end.
        const speaking: MailSender = pane.team
          ? { ...from, role: pane.team.role }
          : from;
        // A teammate's ROLE outranks every other way to name a pane — see
        // `resolveMailTarget`. A workspace with no teams behaves exactly as
        // it did before teams existed.
        const resolved = resolveMailTarget(
          workspace,
          deps.agents(),
          pane,
          str(args, "to") ?? "",
        );
        if (!resolved.ok) throw new Error(resolved.message);
        const result = deps.mail.send({
          from: speaking,
          toPaneId: resolved.value.id,
          kind: kind as MailKind,
          body: args.body as string,
          ...(str(args, "replyTo") ? { replyTo: str(args, "replyTo") } : {}),
        });
        if (!result.ok) throw new Error(refusalText(result.refusal));
        // ACCEPTED either way, and the answer has to say so in a word rather
        // than in a boolean. Shown `delivered: false`, a lead read it as
        // failure: it re-sent, then went looking for whether its teammates
        // were alive at all, while three perfectly good messages sat in the
        // queue. `queued` is the normal outcome for a teammate that is not
        // mid-turn, and it is not something the sender can or should fix.
        return {
          id: result.id,
          status: result.delivered ? "delivered" : "queued",
          note: result.delivered
            ? "handed to the recipient now"
            : "waiting for the recipient's next turn boundary — it will land on its own; do not re-send or go looking",
        };
      },
    }),

    registry.register({
      id: "mail.inbox",
      title: "Read messages other agents sent you",
      args: [
        {
          name: "since",
          type: "string",
          description: "Id of the last message you already read; omit for everything held",
        },
      ],
      run: (args, source) => {
        const reader = requireSender(source);
        // A pane reads its OWN inbox and cannot name another's. There is no
        // argument for whose mail to read, which is the cheapest possible
        // form of that rule.
        const since = str(args, "since");
        return deps.mail
          .inbox(reader.paneId, since)
          .map(wire);
      },
    }),
    registry.register({
      id: "team.assign",
      title: "Put an agent on a team under a role",
      args: [
        {
          name: "agent",
          type: "string",
          required: true,
          description: "Agent pane title, name, or id — in your own workspace",
        },
        {
          name: "team",
          type: "string",
          description: "Team name; omit to take the agent off its team",
        },
        {
          name: "role",
          type: "string",
          description: `The role it takes, which is also how teammates address it — one of ${teamRoles()
            .map((role) => (role.repeatable ? `${role.id}-<n>` : role.id))
            .join(", ")}; omit to remove`,
        },
      ],
      /**
       * The same settle the dialog performs, from an agent instead.
       *
       * It goes through `planTeam` + `applyTeamPlan` rather than writing the
       * role straight in, because everything ELSE that joining a team means
       * lives there: the joiner is briefed, the members whose roster just
       * changed are re-briefed, and anyone taken off is told so. Recording
       * the role alone built teams whose members never learned they were on
       * one — they held an address nobody had told them about, and could not
       * be told until a fresh session happened to restate it.
       *
       * The roster it settles is the team AS IT WILL BE: everyone holding
       * the name, minus this pane, plus what it was asked to become. So the
       * rules the dialog obeys — one lead, unique addresses, known roles, no
       * poaching from another team — are obeyed here by construction rather
       * than by a second, weaker copy.
       */
      run: async (args, source) => {
        const caller = requireSender(source);
        const { workspace } = callerWorkspace(deps, caller);
        const target = resolvePaneRef(workspace, deps.agents(), str(args, "agent") ?? "");
        if (!target.ok) throw new Error(target.message);
        const paneId = target.value.id;
        const name = str(args, "team");
        const role = str(args, "role");
        const held = target.value.team;
        // Which team's roster is being settled: the one named, or — when the
        // agent is being taken off — the one it is on. A pane on no team
        // that is asked to leave one has nothing to settle.
        const team = name ?? held?.name;
        if (!team) return { paneId, team: null };
        const members = teamMembers(workspace, team)
          .filter((pane) => pane.id !== paneId)
          .map((pane) => ({ paneId: pane.id, role: pane.team!.role }));
        if (name || role) members.push({ paneId, role: role ?? "" });
        const planned = planTeam(
          workspace,
          { name: team, members, recruits: [] },
          team,
        );
        if (!planned.ok) throw new Error(planned.message);
        await applyTeamPlan(rosterPorts(deps), workspace.id, planned.value);
        return {
          paneId,
          team: name || role ? { name: planned.value.name, role: role ?? "" } : null,
        };
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/** Why the deck would not take a message, said to the agent that tried.
 * Prose lives here rather than in the domain, the same split
 * `resumeRefusalText` draws. */
function refusalText(refusal: SendRefusal): string {
  switch (refusal) {
    case "self-addressed":
      return "a pane cannot send mail to itself";
    case "not-yours-to-assign":
      return `only ${leadRole().id} hands out work on a team — send a question or a note instead, or ask ${leadRole().id} to assign it`;
    case "hop-limit":
      return "this exchange has gone back and forth too many times — answer it yourself, or ask the user";
  }
}
