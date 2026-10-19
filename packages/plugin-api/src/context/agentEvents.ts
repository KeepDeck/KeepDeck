/**
 * Whose event this is, and what it may do — one rule for every agent.
 *
 * A hook fires for a subagent as well as for the pane's main agent, and the
 * CLIs say so differently or not at all. Each agent's plugin answers only
 * the dialect question — who raised this report, and may it move the pane —
 * as an [`EventAttribution`]. What follows from that answer is decided here
 * and nowhere else:
 *
 * - a report moves the pane's status only when its plugin says it may
 *   (a subagent's tool use clears a claude approval wait; a codex
 *   subagent's prompt does not start the pane's turn);
 * - mail goes out only on an event the plugin DECLARED as a mail channel,
 *   raised by the MAIN agent, in a payload that arrived whole. A message
 *   handed to a subagent never reaches the agent it was written for, and the
 *   queue books it delivered all the same.
 */
import type { AgentStatus, MailReplyRenderer, StatusNormalizer } from "./status.ts";
import { decodeStatusPayload } from "./status.ts";
import { asNonEmptyString } from "./usage.ts";

/** Who raised a report: the pane's main agent, a subagent, or nobody the
 * payload can name. An absent agent field proves nothing by itself — the
 * plugin says "main" only where its CLI's contract makes absence mean it. */
export type EventActor = "main" | "child" | "unknown";

/**
 * The actor of a hook payload in the dialect claude and codex share: a
 * subagent's hook carries `agent_id`; the main agent's carries none, so a
 * hook with the session's own id and no agent id is the main agent's. A
 * payload the reporter reduced names nobody — the field that would tell is
 * the one the reduction dropped.
 */
export function agentIdActor(
  event: Record<string, unknown>,
  reduced: boolean,
): EventActor {
  if (asNonEmptyString(event.agent_id)) return "child";
  return asNonEmptyString(event.session_id) && !reduced ? "main" : "unknown";
}

/** A plugin's reading of one status payload. */
export interface EventAttribution {
  /** The CLI's own name for the event (`Stop`, `mail.ask`, …); null for a
   * record of the agent's store, which no mail channel answers. */
  readonly event: string | null;
  readonly actor: EventActor;
  /** Whether this report may move the pane's status. Not derived from the
   * actor: some CLIs' subagent events are pane-wide facts. */
  readonly status: boolean;
}

/** An event on which this agent's hook asks the deck for its mail. */
export interface MailChannel {
  readonly event: string;
  /** Whether this channel runs as the agent's turn ends — what lets the deck
   * hold a message for a working pane instead of waking it. */
  readonly atTurnEnd: boolean;
}

/** How an agent carries teammate mail: where it asks, and how its CLI must
 * hear the answer. */
export interface AgentMail {
  readonly channels: readonly MailChannel[];
  readonly render: MailReplyRenderer;
}

/** The status normalizer the host runs: the plugin's own, behind the one
 * admission rule. A report the plugin attributes as not moving the pane is
 * no report — no edge, and no change to the decoder's checkpoint. */
export function admittedNormalizer(
  status: Pick<AgentStatus, "normalize" | "attribute">,
): StatusNormalizer {
  return (payload, at, context) =>
    status.attribute(payload)?.status === true
      ? status.normalize(payload, at, context)
      : null;
}

/** Whether mail may be handed out on this payload: the renderer, or why
 * not. Asked BEFORE anything is taken from the queue. */
export type MailAdmission =
  | { readonly render: MailReplyRenderer }
  | { readonly refused: string };

export function admitMail(
  status: Pick<AgentStatus, "attribute" | "mail">,
  payload: unknown,
): MailAdmission {
  const mail = status.mail;
  if (!mail) return { refused: "the agent carries no mail" };
  const decoded = decodeStatusPayload(payload);
  if (decoded?.source !== "hook") return { refused: "not a hook event" };
  // A reporter cut the payload down to its event name: whoever raised it
  // can no longer be told, so it is never the main agent's for sure.
  if (decoded.reduced) return { refused: "the payload was reduced" };
  const attribution = status.attribute(payload);
  if (!attribution || attribution.event === null) {
    return { refused: "an unreadable event" };
  }
  // The reason is logged, and the event's name is whatever the pane's process
  // wrote: it stays out of the text.
  if (!mail.channels.some((channel) => channel.event === attribution.event)) {
    return { refused: "the event is not a mail channel" };
  }
  if (attribution.actor !== "main") {
    return { refused: `raised by a ${attribution.actor === "child" ? "subagent" : "caller nobody can name"}` };
  }
  return { render: mail.render };
}

/** Whether this agent collects mail as its turn ends — so a message for a
 * working pane can wait for the boundary instead of waking it. */
export function collectsAtTurnEnd(mail: AgentMail | undefined): boolean {
  return mail?.channels.some((channel) => channel.atTurnEnd) ?? false;
}

/** The reporter's argument for one armed event: `--ask` exactly on a
 * declared mail channel. The one place that decision is spelled. */
export function mailAskArgs(
  channels: readonly MailChannel[],
  event: string,
): readonly string[] {
  return channels.some((channel) => channel.event === event) ? ["--ask"] : [];
}
