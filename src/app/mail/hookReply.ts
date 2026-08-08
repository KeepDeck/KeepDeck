/**
 * Answering a pane's agent when it asks, at its own turn boundary, whether
 * anything is waiting for it.
 *
 * This is the labelled channel. What goes back is rendered by the agent's
 * OWN plugin (`AgentStatus.renderMail`), so the deck never learns a CLI's
 * hook-output schema — the same division the status normalizers already
 * draw. The deck decides WHAT to say; the plugin decides how that CLI hears
 * it.
 *
 * One round trip serves both halves of §8's problem: the status the hook is
 * reporting and the mail question it is asking arrive in one envelope and
 * are answered in one handler, so a pane can never be marked finished by
 * one half while the other half is still deciding to keep it running.
 */
import { isRecord } from "../../domain/json";
import type { DeliverableMail, MailReplyRenderer } from "@keepdeck/plugin-api";
import type { Mail } from "../../domain/mail";
import { log } from "../../ipc/log";
import type { MailManager } from "./mailManager";

export interface HookReplyDeps {
  /** The live mail owner, or null while the feature is off. Looked up per
   * call — the toggle can flip between two hook invocations. */
  mail(): MailManager | null;
  /** This agent's mail renderer, when its plugin ships one. */
  rendererFor(agentId: string): MailReplyRenderer | undefined;
  /** Hand the rendered answer back to the waiting hook. */
  reply(correlation: string, body: string): void;
}

/** The correlation a payload is asking on, or null when it only reports. */
export function correlationOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const reply = payload.reply;
  return typeof reply === "string" && reply ? reply : null;
}

/** One message as a plugin renderer sees it: who spoke, flattened to a name,
 * because a renderer builds prose and has no use for the pane behind it. */
function forAgent(mail: Mail): DeliverableMail {
  return {
    id: mail.id,
    kind: mail.kind,
    body: mail.body,
    // The ROLE, because the receiver answers to whatever it is shown — and
    // only a role is an address. A pane title is not one: shown a title, an
    // agent sent to the title and was refused. The title is the fallback for
    // a sender on no team, where there is no address to give.
    from:
      mail.from.kind === "pane"
        ? (mail.from.pane.role ?? mail.from.pane.label)
        : null,
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
  };
}

/**
 * Answer one asking payload. Silence is a real answer and the common one —
 * most turns end with nothing waiting.
 *
 * Mail is TAKEN before rendering, and put back if nothing can be rendered.
 * The order matters: taking first is what stops the terminal delivering the
 * same message a moment later, and putting back is what stops an event that
 * cannot carry mail (a `PostToolUse` armed for asking, a plugin that renders
 * nothing) from swallowing it.
 */
export function answerMailAsk(
  deps: HookReplyDeps,
  paneId: string,
  payload: unknown,
): void {
  const correlation = correlationOf(payload);
  if (!correlation) return;
  const manager = deps.mail();
  // Always answer, even with nothing: a hook that gets no file waits out its
  // whole timeout, and doing that on every turn end would tax every pane for
  // the sake of the rare one with mail.
  const answerNothing = () => deps.reply(correlation, "");
  if (!manager || !isRecord(payload)) return answerNothing();
  const agent = typeof payload.agent === "string" ? payload.agent : "";
  const render = deps.rendererFor(agent);
  const event = isRecord(payload.event) ? payload.event : null;
  if (!render || !event) return answerNothing();
  const taken = manager.takeAtTurnEnd(paneId);
  if (taken.length === 0) return answerNothing();
  const rendered = render({ event, messages: taken.map(forAgent) });
  // The one place that knows WHICH hook event a message left through. Without
  // it, a message that reached the pane's inbox and never reached its context
  // is indistinguishable from one the plugin declined to render: both end
  // with the queue empty and nothing in the terminal.
  log.info(
    "web:mail",
    `answering ${agent} ${String(event.hook_event_name)} on ${correlation}` +
      ` with ${taken.length} message(s): ${rendered === null ? "this event carries none" : `${rendered.length} bytes`}`,
  );
  if (rendered === null) {
    // This event cannot carry mail after all. Give it back rather than drop
    // it — the pane will ask again at an event that can, and the ordinary
    // terminal fallback is still waiting behind that.
    manager.restore(taken);
    return answerNothing();
  }
  deps.reply(correlation, rendered);
}
