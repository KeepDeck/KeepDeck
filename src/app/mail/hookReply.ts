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
 *
 * There used to be more here: a memory of what every outstanding answer
 * carried, a timer to expire it, and a handler for the transport's report
 * that nobody had collected one. All of it existed to answer a single
 * question — did the hook actually get this — which the transport could not
 * answer while an answer was a file somebody might or might not come for. A
 * hook parked on an open connection is either still there or not, so the
 * send answers it, and the machinery that guessed is gone.
 */
import { isRecord } from "../../domain/json";
import type { DeliverableMail, MailReplyRenderer } from "@keepdeck/plugin-api";
import { isStandingContext, senderName, type Mail } from "../../domain/mail";
import { log } from "../../ipc/log";
import type { MailManager } from "./mailManager";

export interface HookReplyDeps {
  /** The live mail owner, or null while the feature is off. Looked up per
   * call — the toggle can flip between two hook invocations. */
  mail(): MailManager | null;
  /** This agent's mail renderer, when its plugin ships one. */
  rendererFor(agentId: string): MailReplyRenderer | undefined;
  /** What this agent's own binary answers to `--version`, or null when that
   * could not be read. A hook-output schema belongs to a RELEASE — codex
   * changed its whole shape at 0.147 — so the renderer needs it to pick. */
  versionOf(agentId: string): string | null;
  /** Hand the rendered answer back to the waiting hook, and say whether it
   * got there. The pane travels with it: the ANSWER is addressed by pane, so
   * an envelope naming another pane's correlation cannot reach that pane. */
  reply(paneId: string, correlation: string, body: string): Promise<boolean>;
}

/** The labelled channel, as one owner: it answers asks. */
export interface HookReplies {
  /** Answer one asking payload from `paneId`. */
  answer(paneId: string, payload: unknown): void;
}

/** The correlation a payload is asking on, or null when it only reports.
 *
 * Non-empty and nothing more, which is the whole of the transport's contract
 * (`Report::correlation` in bridge/wire.rs): a correlation is an opaque token
 * the deck hands straight back, a key in a map on the way, and a string in a
 * log line at the end.
 *
 * It used to be a permit-list, `[A-Za-z0-9_-]{1,64}`, mirroring the rule the
 * transport applied before it could write an answer to a file. That is worth
 * one sentence because the reason DIED rather than weakened: there is no file
 * and no write to refuse, so the gate had stopped protecting anything and had
 * become the only thing that could lose a turn — a correlation of 70
 * characters got no answer from a deck whose transport would have carried it
 * without complaint. The one place a correlation is still dangerous is the
 * log line, and that is answered at the log line, with `printable`.
 *
 * Should a correlation ever become a name again — a file, a directory — the
 * grammar is born again THERE, with its own reason. It does not come back
 * from here.
 */
export function correlationOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const reply = payload.reply;
  return typeof reply === "string" && reply !== "" ? reply : null;
}

/** One message as a plugin renderer sees it: who spoke, flattened to a name,
 * because a renderer builds prose and has no use for the pane behind it. */
function forAgent(mail: Mail): DeliverableMail {
  return {
    id: mail.id,
    kind: mail.kind,
    // Answered HERE, from the deck's own rule, so a plugin that delivers
    // context and traffic differently never has to guess which kinds are
    // which — a second copy of that list is a second thing to keep in step.
    standing: isStandingContext(mail.kind),
    body: mail.body,
    from: senderName(mail),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
  };
}

export function createHookReplies(deps: HookReplyDeps): HookReplies {
  return { answer: (paneId, payload) => answerMailAsk(deps, paneId, payload) };
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
function answerMailAsk(
  deps: HookReplyDeps,
  paneId: string,
  payload: unknown,
): void {
  const manager = deps.mail();
  // Named by whichever field this reporter's CLI uses. The hook CLIs send
  // `hook_event_name`; an in-process reporter has no hook and names its own
  // question under `type`. Getting this wrong costs the only window there is
  // onto the labelled channel — "asked on undefined" tells nobody anything.
  //
  // Trimmed to a plain short token before it goes in a log line. The name
  // comes out of an envelope, so it is whatever the pane's process wrote —
  // a newline in it forges a second log entry, and a long one buries the
  // real lines. An event named unprintably is not worth a diagnosis.
  const named = (value: unknown) =>
    typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : null;
  const asking =
    (isRecord(payload) && isRecord(payload.event)
      ? (named(payload.event.hook_event_name) ?? named(payload.event.type))
      : null) ?? "an unreadable event";
  // EVERY ask is logged, answered or not. This is the only window onto the
  // labelled channel: a briefing that never reaches an agent's context and a
  // hook that never asked look identical from outside, and the difference is
  // the whole diagnosis.
  const said = (why: string) =>
    log.info("web:mail", `${paneId} asked on ${asking} → ${why}`);

  const correlation = correlationOf(payload);
  // No correlation at all: this envelope reports and asks nothing, which is
  // most of them. Still logged — a hook that asked and a hook that never ran
  // look identical from outside, and the difference is the whole diagnosis.
  if (!correlation) return said("no correlation — this envelope only reports");
  // The same correlation twice, with the first ask still waiting, is refused
  // by the TRANSPORT and never arrives here: it holds a slot per pane and
  // correlation, and turns the second one away rather than announcing it.
  // This side used to guard that with a memory of what was outstanding —
  // the memory that went away with the file it described.
  const answer = (body: string, why: string) => {
    said(why);
    // Nothing to lose: an empty answer means "nothing was waiting for you",
    // so whether it lands changes nothing that has to be put back.
    void deps.reply(paneId, correlation, body);
  };
  // Always answer, even with nothing: a hook that gets no reply waits out its
  // whole timeout, and doing that on every turn end would tax every pane for
  // the sake of the rare one with mail.
  if (!manager || !isRecord(payload)) return answer("", "mail is off");
  const agent = typeof payload.agent === "string" ? payload.agent : "";
  const render = deps.rendererFor(agent);
  const event = isRecord(payload.event) ? payload.event : null;
  if (!render || !event) {
    return answer("", render ? "malformed payload" : `${agent} renders no mail`);
  }
  const taken = manager.takeAtTurnEnd(paneId);
  if (taken.length === 0) {
    // "Nothing waiting" is only honest when nothing IS waiting. A hand-over
    // the door refused leaves the queue exactly as it was, and answering an
    // empty inbox there is the one lie this lane tells about itself — the
    // pane looks idle in the log while its mail sits held.
    //
    // With nothing taken, the refusal has one cause: the budget cannot stop
    // a walk before its first message, and standing context is stepped over
    // rather than stopping it, so what is left is the permission prompt.
    // The count was already being read a few lines below; it just was not
    // being asked before the answer.
    const held = manager.waiting(paneId);
    return answer(
      "",
      held > 0 ? `${held} held — the pane is at a prompt` : "nothing waiting",
    );
  }
  const rendered = render({
    event,
    messages: taken.map(forAgent),
    // Read AFTER the hand-over, so it counts what the turn's budget left
    // behind rather than what was waiting before it.
    waiting: manager.waiting(paneId),
    cliVersion: deps.versionOf(agent),
  });
  if (!rendered) {
    // This event cannot carry mail after all. Give it back rather than drop
    // it — the pane will ask again at an event that can.
    //
    // Empty counts as null, not as "an answer that happens to be blank":
    // answering "" would tell the hook nothing was waiting while the deck
    // had already taken these out of the queue to hand over.
    manager.restore(taken);
    return answer("", `${agent} cannot carry mail on this event`);
  }
  said(
    `injecting ${taken.length} message(s), ${rendered.length} bytes: ${taken
      .map((mail) => `${mail.id}/${mail.kind}`)
      .join(" ")}`,
  );
  // The one answer that CAN be lost — those messages left the queue to travel
  // in it — and so the one that is watched. Not with a timer and a guess, as
  // a file needed: the send itself either reaches the parked hook or says it
  // did not.
  //
  // Put back into the manager they CAME FROM, captured here rather than
  // looked up again. The two differ if the feature toggled in between, and
  // restoring into a fresh manager would resurrect mail into a queue the
  // user had deliberately cleared; a disposed one takes them back inertly,
  // which is the right ending for messages whose queue no longer exists.
  void deps.reply(paneId, correlation, rendered).then((delivered) => {
    if (delivered) return;
    log.warn(
      "web:mail",
      `${paneId} was gone before its answer arrived — putting back ${taken
        .map((mail) => mail.id)
        .join(" ")}`,
    );
    manager.restore(taken);
  });
}
