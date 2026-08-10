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
  /** Hand the rendered answer back to the waiting hook. The pane travels
   * with it: the ANSWER is addressed by pane, so an envelope naming another
   * pane's correlation cannot be used to reach that pane. */
  reply(paneId: string, correlation: string, body: string): void;
  /** `setTimeout`, injected so tests drive the clock. Returns its cancel. */
  schedule?(fn: () => void, ms: number): () => void;
}

/**
 * How long an answer with content is remembered after it is handed over.
 *
 * The transport reports only FAILURE — it waits its own window and then says
 * "nobody came for this one" — so a successful hand-over is never confirmed
 * and has to age out. Comfortably past that window: too short and a genuine
 * report arrives to find nothing to put back; too long only holds a few
 * messages in a map.
 */
const HANDOVER_MEMORY_MS = 30_000;

/** The labelled channel, as one owner: it answers asks, and it remembers what
 * each answer carried for exactly as long as that answer can still be
 * reported unread. */
export interface HookReplies {
  /** Answer one asking payload from `paneId`. */
  answer(paneId: string, payload: unknown): void;
  /** The transport saw an answer nobody collected. The messages it carried
   * left the queue to be written there, so they go back. */
  uncollected(paneId: string, correlation: string): void;
  /** Forget every outstanding hand-over, cancelling its timer.
   *
   * Called when the queues those messages came from are destroyed — the
   * feature toggling off, or the owner disposing. Without it the memory
   * outlives what it describes: a report arriving after a toggle would put
   * messages taken from a dead queue into a live one, resurrecting mail into
   * a pane that was deliberately cleared. */
  forgetAll(): void;
}

/**
 * What a correlation may be — the SAME permit-list the transport applies
 * (`spool::is_usable_name`), because the two grammars disagreeing is how mail
 * gets destroyed.
 *
 * The correlation comes out of an envelope, so it is the agent's word. This
 * side used to accept any non-empty string and the transport only
 * `[A-Za-z0-9_-]{1,64}` — so an ask carrying `"a b"` made the deck empty the
 * pane's queue, render it, and hand it to a write that refused. No file, so
 * no watchdog, so no uncollected report: the messages aged out of the
 * hand-over memory and were gone, with every sender told they had been
 * delivered. Repeatable at will by whatever is running in that pane.
 *
 * `scripts/reporterScripts.test.mjs` pins this against the Rust rule, the
 * same way it pins the ask window.
 */
const USABLE_CORRELATION = /^[A-Za-z0-9_-]{1,64}$/;

/** The correlation a payload is asking on, or null when it only reports —
 * and null for one the transport could not answer on, which reads as "this
 * envelope reports and asks nothing". The mail then stays in its queue. */
export function correlationOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const reply = payload.reply;
  return typeof reply === "string" && USABLE_CORRELATION.test(reply)
    ? reply
    : null;
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
export function createHookReplies(deps: HookReplyDeps): HookReplies {
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  /** What each outstanding answer carried, keyed by pane AND correlation —
   * the same pair the transport reports back, and the reason a correlation
   * borrowed from another pane cannot reclaim that pane's messages. Each
   * entry also remembers WHICH manager it was taken from, because that is
   * the only queue it may go back into. */
  const handedOver = new Map<
    string,
    { messages: Mail[]; from: MailManager; forget: () => void }
  >();
  const key = (paneId: string, correlation: string) =>
    `${paneId}\0${correlation}`;

  const remember: Remember = (paneId, correlation, messages, from) => {
    const at = key(paneId, correlation);
    handedOver.get(at)?.forget();
    handedOver.set(at, {
      messages,
      from,
      forget: schedule(() => handedOver.delete(at), HANDOVER_MEMORY_MS),
    });
  };

  return {
    answer: (paneId, payload) =>
      answerMailAsk(deps, paneId, payload, remember),
    forgetAll() {
      for (const outstanding of handedOver.values()) outstanding.forget();
      handedOver.clear();
    },
    uncollected(paneId, correlation) {
      const outstanding = handedOver.get(key(paneId, correlation));
      if (!outstanding) return;
      outstanding.forget();
      handedOver.delete(key(paneId, correlation));
      // Restored into the manager the messages CAME FROM, not into whatever
      // is live now. The two differ whenever the feature toggled between the
      // hand-over and the report, and putting them into a fresh manager
      // would resurrect mail into a queue the user had cleared.
      log.warn(
        "web:mail",
        `${paneId} never read its answer — putting back ${outstanding.messages
          .map((mail) => mail.id)
          .join(" ")}`,
      );
      outstanding.from.restore(outstanding.messages);
    },
  };
}

/** Book what one answer carried, against the queue it came out of. */
type Remember = (
  paneId: string,
  correlation: string,
  messages: Mail[],
  from: MailManager,
) => void;

function answerMailAsk(
  deps: HookReplyDeps,
  paneId: string,
  payload: unknown,
  remember: Remember,
): void {
  const correlation = correlationOf(payload);
  if (!correlation) return;
  const manager = deps.mail();
  // Named by whichever field this reporter's CLI uses. The hook CLIs send
  // `hook_event_name`; an in-process reporter has no hook and names its own
  // question under `type`. Getting this wrong costs the only window there is
  // onto the labelled channel — "asked on undefined" tells nobody anything.
  const named = (value: unknown) =>
    typeof value === "string" && value ? value : null;
  const asking =
    (isRecord(payload) && isRecord(payload.event)
      ? (named(payload.event.hook_event_name) ?? named(payload.event.type))
      : null) ?? "an unreadable event";
  // EVERY ask is logged, answered or not. This is the only window onto the
  // labelled channel: a briefing that never reaches an agent's context and a
  // hook that never asked look identical from outside, and the difference is
  // the whole diagnosis.
  const answer = (body: string, why: string) => {
    log.info("web:mail", `${paneId} asked on ${asking} → ${why}`);
    deps.reply(paneId, correlation, body);
  };
  // Always answer, even with nothing: a hook that gets no file waits out its
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
  if (taken.length === 0) return answer("", "nothing waiting");
  const rendered = render({
    event,
    messages: taken.map(forAgent),
    cliVersion: deps.versionOf(agent),
  });
  if (rendered === null) {
    // This event cannot carry mail after all. Give it back rather than drop
    // it — the pane will ask again at an event that can.
    manager.restore(taken);
    return answer("", `${agent} cannot carry mail on this event`);
  }
  // Remembered BEFORE the answer goes out: the transport starts its own
  // clock the moment it writes, and a report that beat this line would find
  // nothing to put back.
  remember(paneId, correlation, taken, manager);
  answer(
    rendered,
    `injecting ${taken.length} message(s), ${rendered.length} bytes: ${taken.map((mail) => `${mail.id}/${mail.kind}`).join(" ")}`,
  );
}
