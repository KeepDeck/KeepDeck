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
 * thing a `task` is weighed against, and the only answer to "whose inbox is
 * this".
 */
import {
  resolvePaneRef,
  type CommandArgs,
  type CommandRegistry,
  type CommandSource,
} from "../../domain/commands";
import { findWorkspaceOfPane, type Pane, type Workspace } from "../../domain/deck";
import {
  SENDABLE_KINDS,
  isMessageId,
  kindGuidance,
  planTeam,
  teamMembers,
  leadRole,
  resolveMailTarget,
  senderAddress,
  senderOf,
  teamRoles,
  type Mail,
  type MailKind,
  type MailSender,
  type SendRefusal,
} from "../../domain/mail";
import { log } from "../../ipc/log";
import type { MailManager } from "./mailManager";
import { applyTeamPlan, type TeamSetupDeps } from "./teamSetup";

export interface MailCommandDeps {
  mail: MailManager;
  /** The deck as it stands, as WORKSPACES and nothing else.
   *
   * Not the `Deck` surface: that is the return type of a React hook, so
   * naming it here would make a command handler's contract depend on the view
   * layer's shape — every action, every selector, all of it — for the one
   * field it reads. What these commands need is a list of workspaces, and
   * saying so keeps them testable with a literal. */
  workspaces(): readonly Workspace[];
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
  const workspace = findWorkspaceOfPane(deps.workspaces(), sender.paneId);
  const pane = workspace?.panes.find((p) => p.id === sender.paneId);
  if (!workspace || !pane) throw new Error(NOT_AN_AGENT_MESSAGE);
  return { workspace, pane };
}


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

/**
 * One message as the calling agent sees it.
 *
 * The sender is named THREE ways because a receiver asks three different
 * questions about it, and answering them with one field is what sent an
 * agent looking for a window title: `address` is what goes in `to`, `label`
 * is how a person reads it, `paneId` is who spoke and stays the same as long
 * as that pane lives. Only `address` is an address, and the domain answers
 * it — the two delivery channels ask the same rule through [`senderName`],
 * which is [`senderAddress`] for a whole message — and a
 * projection with an opinion of its own is how this read path came to be the
 * one that showed a title while the other two showed a role.
 *
 * Field by field on purpose, never a spread: what an agent may read is a
 * decision, and a message gaining an internal field later must not start
 * arriving on the wire because nobody thought about it here.
 */
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
            address: senderAddress(mail.from.pane),
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
          // Named the way a reply is actually addressed. Saying "title, name,
          // or id" described the fallback and left out the one name a
          // teammate can be sure of, while the briefing taught roles — so
          // the two surfaces an agent reads disagreed about how to answer.
          description:
            "Recipient's address in your own workspace: the role a message shows as `from.address` (lead, impl-1). A pane title or id also resolves, and is all there is for an agent on no team",
        },
        {
          name: "kind",
          type: "string",
          required: true,
          // Not a bare list any more. The kind decides whether a teammate is
          // pulled out of its work, so an agent choosing one is spending
          // somebody else's turn — and it can only weigh that if it is told.
          description: `What this is: ${SENDABLE_KINDS.join(", ")}. It decides when the message lands — ${kindGuidance(SENDABLE_KINDS)} Say what is true: an interrupt nobody needed is a teammate's turn spent for nothing.`,
        },
        { name: "body", type: "string", required: true, description: "The message" },
        // No `replyTo`. The deck derives the edge from what this pane was
        // handed for the turn it is in — see [`MailManager.send`]. Left as an
        // argument it would be bookkeeping an agent maintains by hand, which
        // costs briefing lines, is checked by nothing, and taught agents to
        // hoard message ids they then fed to `mail.inbox`'s `since`.
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
      title: "Read the messages waiting for you",
      args: [
        {
          name: "all",
          type: "boolean",
          description:
            "Re-read the most recent messages still held, including ones you have already read — for when your context was rebuilt and you need to know what you are still on the hook for. Omit for just the new ones",
        },
      ],
      run: (args, source) => {
        const reader = requireSender(source);
        // A pane reads its OWN inbox and cannot name another's. There is no
        // argument for whose mail to read, which is the cheapest possible
        // form of that rule.
        const { messages, waiting } = deps.mail.inbox(reader.paneId, {
          all: args.all === true,
        });
        return {
          messages: messages.map(wire),
          // Said in the answer because the alternative is an agent that
          // stops at what it was given: a turn's worth of mail is capped,
          // and what did not fit is invisible unless the deck says so.
          waiting,
          note:
            waiting > 0
              ? `${waiting} more waiting — read them with another mail.inbox call`
              : "nothing else is waiting for you",
        };
      },
    }),
    registry.register({
      id: "mail.cancel",
      title:
        "Take back a message you sent, if the recipient has not read it yet. It does NOT stop or interrupt the recipient — a working teammate keeps working, and the fix for a message already read is a new message, not this tool",
      args: [
        {
          name: "id",
          type: "string",
          required: true,
          description:
            "The id mail.send answered with, passed through unchanged (mail-7)",
        },
        {
          name: "to",
          type: "string",
          required: true,
          // Both, always. An agent that mistyped an id would otherwise reach
          // into a message it never meant; naming the recipient as well turns
          // that slip into a refusal instead of somebody else's mail
          // disappearing.
          description:
            "Who you sent it to, as the address that reaches them today — confirms you mean this message and not another",
        },
      ],
      run: (args, source) => {
        const from = requireSender(source);
        const id = str(args, "id") ?? "";
        // Shape first, so a caller that passed a ROLE — the likeliest slip,
        // since every other mail argument is an address — is told what it did
        // rather than told its message does not exist.
        if (!isMessageId(id)) {
          throw new Error(
            `${JSON.stringify(id)} is not a message id — pass the id exactly as mail.send answered`,
          );
        }
        // Ownership BEFORE the address is resolved, and that order is the
        // rule rather than a preference. "That message is not yours" would
        // confirm the id exists, and an agent could walk the ids until the
        // wording changed and count a conversation it never saw. One answer
        // covers not-yours, never-existed and long-forgotten alike.
        const mail = deps.mail.findSent(from.paneId, id);
        if (!mail) {
          throw new Error(
            `no message of yours with id ${JSON.stringify(id)} — it may never have existed, or the deck may no longer be tracking it`,
          );
        }
        const { workspace, pane } = callerWorkspace(deps, from);
        const resolved = resolveMailTarget(
          workspace,
          deps.agents(),
          pane,
          str(args, "to") ?? "",
        );
        if (!resolved.ok) throw new Error(resolved.message);
        // Its own traffic, so this one may be plain: the sender is being told
        // where its own message went.
        if (mail.toPaneId !== resolved.value.id) {
          throw new Error(
            `${id} is yours but went somewhere else — check which message you meant`,
          );
        }
        const outcome = deps.mail.cancel(from.paneId, id);
        return outcome.kind === "cancelled"
          ? { status: "cancelled", note: "it will not be delivered" }
          : {
              status: "too-late",
              note: `${id} has left the deck and cannot be taken back — send a correction as a new message if it matters`,
            };
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
          // Composed at REGISTRATION, so the enumeration is a snapshot; the
          // trailing clause is what keeps the sentence true after the user
          // edits the catalog mid-session.
          description: `The role it takes, which is also how teammates address it — one of ${teamRoles()
            .map((role) => (role.repeatable ? `${role.id}-<n>` : role.id))
            .join(", ")}, plus any role added in Settings → Team roles; omit to remove`,
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
        if (!team) {
          // A role with no team to hold it. Answering "done, team: null" here
          // told the caller its request had been carried out while nothing
          // happened at all — the failure an agent cannot see and so keeps
          // building on.
          if (role) {
            throw new Error(
              `${str(args, "agent")} is not on a team — name the team to put it on one`,
            );
          }
          return { paneId, team: null };
        }
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
  switch (refusal.kind) {
    case "self-addressed":
      return "a pane cannot send mail to itself";
    case "not-yours-to-assign":
      // The honest next step differs by where the sender stands: a working
      // role has a lead to ask, a peer's team has nobody who assigns at all.
      return refusal.sender === "peer"
        ? "this team is flat: nobody assigns work here — say it as a question or a note"
        : `only ${leadRole().id} hands out work on a team — send a question or a note instead, or ask ${leadRole().id} to assign it`;
  }
}
