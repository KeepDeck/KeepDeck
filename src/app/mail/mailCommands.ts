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
  checkTeamAssignment,
  LEAD_ROLE,
  resolveMailTarget,
  senderOf,
  type Mail,
  type MailKind,
  type MailSender,
} from "../../domain/mail";
import type { Deck } from "../useDeck";
import type { MailManager } from "./mailManager";

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
      title: "Send a message to another agent",
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
          from,
          toPaneId: resolved.value.id,
          kind: kind as MailKind,
          body: args.body as string,
          ...(str(args, "replyTo") ? { replyTo: str(args, "replyTo") } : {}),
        });
        if (!result.ok) throw new Error(refusalText(result.refusal));
        // `delivered` is not a read receipt and says so in the description:
        // a message handed to a running turn is read whenever that turn gets
        // to it, and one that is false will land when the pane can take it.
        return { id: result.id, delivered: result.delivered };
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
          description: `How teammates will address it (e.g. "${LEAD_ROLE}", "impl-1"); omit to remove`,
        },
      ],
      run: (args, source) => {
        const caller = requireSender(source);
        const { workspace } = callerWorkspace(deps, caller);
        const target = resolvePaneRef(workspace, deps.agents(), str(args, "agent") ?? "");
        if (!target.ok) throw new Error(target.message);
        const name = str(args, "team");
        const role = str(args, "role");
        if (!name && !role) {
          deps.setPaneTeam(workspace.id, target.value.id, null);
          return { paneId: target.value.id, team: null };
        }
        const checked = checkTeamAssignment(workspace, target.value.id, {
          name: name ?? "",
          role: role ?? "",
        });
        if (!checked.ok) throw new Error(checked.message);
        deps.setPaneTeam(workspace.id, target.value.id, checked.value);
        return { paneId: target.value.id, team: checked.value };
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
function refusalText(refusal: "self-addressed" | "hop-limit"): string {
  return refusal === "self-addressed"
    ? "a pane cannot send mail to itself"
    : "this exchange has gone back and forth too many times — answer it yourself, or ask the user";
}
