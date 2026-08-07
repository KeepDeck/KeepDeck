/**
 * The owner of live mail state — one per app, outside React, the sibling of
 * `usageManager` and `agentStatusTracker`.
 *
 * Everything that DECIDES lives in `src/domain/mail`; this holds what the
 * decisions need and nothing else: a queue per receiver, what each pane has
 * already been handed, and where each pane sits in a chain. It is the only
 * stateful piece of the feature, deliberately — a second store would have to
 * agree with this one about whether a message is still pending, and they
 * would disagree exactly when it mattered.
 *
 * A FACTORY, like both its siblings: the app's one instance lives in
 * `createAppRuntime` and reaches consumers as a value, while each test
 * builds a fresh one instead of resetting a shared module.
 *
 * Runtime-only, never persisted. A message describes an intent between two
 * LIVE processes; one restored next launch would be handed to an agent that
 * has no idea what it refers to, and its sender would be long gone.
 */
import {
  MAIL_LIMITS,
  decideDelivery,
  decideSend,
  expiryNotice,
  type Mail,
  type MailKind,
  type MailLimits,
  type MailSender,
  type SendRefusal,
} from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";

/**
 * The smallest gap between two deliveries into the SAME pane.
 *
 * Two blocks pasted back to back land in one input buffer and reach the
 * agent as a single garbled prompt. There is no delivery acknowledgement to
 * wait on — the deck cannot see the agent read anything — so spacing is the
 * only thing that keeps consecutive messages apart.
 */
const SERIALIZE_MS = 400;

/** How many delivered messages a pane keeps for catch-up reads. Bounded
 * because nothing prunes it otherwise and a long-lived pane would grow one
 * without limit. */
const INBOX_LIMIT = 50;

export interface MailSendRequest {
  from: MailSender;
  toPaneId: string;
  kind: MailKind;
  body: string;
  replyTo?: string;
}

export type MailSendResult =
  /** Accepted. `delivered` says whether it landed SYNCHRONOUSLY — it is not
   * a read receipt, and a message delivered into a running turn is read
   * whenever that turn gets to it. */
  | { ok: true; id: string; delivered: boolean }
  | { ok: false; refusal: SendRefusal };

export interface MailManagerDeps {
  /** What this pane is doing right now, or undefined when nothing reports
   * for it. Read per call, never cached: activity moves under us. */
  activityOf(paneId: string): PaneActivity | undefined;
  /** Tell me when any pane's activity changed. A pane leaving a permission
   * prompt is precisely the event a held message waits for, and without
   * this the only thing that could notice would be the expiry timer. */
  subscribeActivity(listener: () => void): () => void;
  /** Tell me when a pane's input channel appears. A terminal mounting emits
   * no status, so this is the ONLY signal that a pane which reported
   * nothing has become writable — and a pane that reports nothing is
   * precisely the one waiting on this. */
  subscribeChannels(listener: () => void): () => void;
  /** Hand one message to its pane. False means the pane has no live input
   * channel at this instant — a retry, not a failure. */
  deliver(mail: Mail): boolean;
  /** Whether this pane's agent asks the deck for its mail when a turn ends.
   * True means a running turn is worth waiting out — the answer given at
   * that boundary is labelled, and a paste is not. */
  asksAtTurnEnd?(paneId: string): boolean;
  now?(): number;
  /** `setTimeout`, injected so tests drive the clock. Returns its cancel. */
  schedule?(fn: () => void, ms: number): () => void;
  limits?: MailLimits;
}

export interface MailManager {
  /** Accept a message, then try to place it immediately. */
  send(request: MailSendRequest): MailSendResult;
  /** Say something to a pane as the DECK, not as another agent.
   *
   * The host already speaks this way for delivery reports; this is the same
   * lane for the other thing only the deck knows — that a pane has joined a
   * team, or left one. It travels the ordinary route, so it waits out a
   * permission prompt and arrives labelled through the hook channel like
   * any other message.
   *
   * Hop zero: a fact stated by the deck starts no conversation and must not
   * spend the pane's chain budget on one.
   */
  announce(paneId: string, kind: MailKind, body: string): void;
  /** Hand over everything waiting for this pane, because its agent just
   * asked at a turn boundary — the moment the labelled channel is open.
   *
   * Takes them out of the queue and books them exactly as a delivery does,
   * so nothing can be handed over twice. Expired messages are dropped and
   * reported to their senders on the way, the same as any other pass, and
   * a message held for a permission prompt stays held: the prompt is about
   * the terminal, and the hook is not going to make it safe.
   */
  takeAtTurnEnd(paneId: string): Mail[];
  /** Put back messages taken at a turn boundary that could not be rendered
   * after all. They go to the FRONT, because they were the oldest waiting
   * and taking them must not cost them their place; their inbox entry is
   * withdrawn too, or a later read would show a message never delivered. */
  restore(messages: readonly Mail[]): void;
  /** What this pane has been handed, oldest first. `since` is the id of the
   * last message the caller already saw; an id that has aged out of the
   * buffer yields everything still held, which is honest — better a repeat
   * than a silent hole. */
  inbox(paneId: string, since?: string): Mail[];
  /** Forget everything belonging to panes that no longer exist. */
  retain(liveIds: ReadonlySet<string>): void;
  /** The pane's process was retired (restart, suspend). Its place in a chain
   * and its delivery spacing describe that process and mean nothing to the
   * next one; queued and delivered mail is addressed to the PANE and stays. */
  clear(paneId: string): void;
  dispose(): void;
}

function earlier(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

export function createMailManager(deps: MailManagerDeps): MailManager {
  const limits = deps.limits ?? MAIL_LIMITS;
  const asksAtTurnEnd = deps.asksAtTurnEnd ?? (() => false);
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      return () => clearTimeout(handle);
    });

  /** Pending mail per receiver, oldest first. A pane with an empty queue is
   * removed, so the map doubles as "who is waiting on something". */
  const queues = new Map<string, Mail[]>();
  /** Delivered mail per receiver, for catch-up reads. */
  const inboxes = new Map<string, Mail[]>();
  /** The hop of the message that last WOKE each pane — what the next message
   * that pane sends inherits. */
  const chainHop = new Map<string, number>();
  /** When each pane last took delivery, for spacing. */
  const lastDeliveryAt = new Map<string, number>();

  let sequence = 0;
  let cancelTimer: (() => void) | null = null;
  let noticed = false;
  let disposed = false;

  function mintId(): string {
    sequence += 1;
    return `mail-${sequence}`;
  }

  function enqueue(mail: Mail): void {
    const queue = queues.get(mail.toPaneId);
    if (queue) queue.push(mail);
    else queues.set(mail.toPaneId, [mail]);
  }

  function remember(paneId: string, mail: Mail): void {
    const held = inboxes.get(paneId) ?? [];
    held.push(mail);
    if (held.length > INBOX_LIMIT) held.splice(0, held.length - INBOX_LIMIT);
    inboxes.set(paneId, held);
  }

  /**
   * Walk one pane's queue as far as it will go, and report when this pane
   * next needs attention (null = nothing pending).
   *
   * At most ONE message is handed over per call: the next needs its spacing
   * gap, and the timer this returns is what comes back for it. Expiring
   * messages do not consume that budget — they never reached the pane.
   */
  function drainPane(paneId: string, queue: Mail[], at: number): number | null {
    for (;;) {
      const head = queue[0];
      if (!head) return null;
      const verdict = decideDelivery(
        head,
        deps.activityOf(paneId),
        at,
        limits,
        asksAtTurnEnd(paneId),
      );
      if (verdict.kind === "expire") {
        queue.shift();
        const notice = expiryNotice(head, mintId(), at);
        if (notice) {
          enqueue(notice);
          noticed = true;
        }
        continue;
      }
      // Held for a turn boundary: the wait is bounded, so the deadline is
      // when waiting stops being worth it — not when the message dies.
      // Missing that distinction would leave a pane whose turn never ends
      // silently losing its mail instead of falling back to the terminal.
      if (verdict.kind === "hold" && verdict.reason === "turn-boundary") {
        return head.at + limits.hookWaitMs;
      }
      // Held on a prompt, or on a pane nothing speaks for. Both resolve
      // through the activity subscription, so the only thing left to
      // schedule is the moment this message stops being worth delivering.
      if (verdict.kind === "hold") return head.at + limits.undeliveredMs;
      const last = lastDeliveryAt.get(paneId);
      if (last !== undefined && at - last < SERIALIZE_MS) return last + SERIALIZE_MS;
      // No input channel: the pane is starting, or stopped. This is the ONE
      // refusal that says so — a pane can be perfectly alive and report no
      // activity at all — and it resolves through `subscribeChannels`, not
      // through activity, because a terminal mounting emits no status. The
      // deadline is only the backstop for a pane that never comes back.
      if (!deps.deliver(head)) return head.at + limits.undeliveredMs;
      queue.shift();
      lastDeliveryAt.set(paneId, at);
      // The receiver now stands one message deep in this chain: whatever it
      // sends next continues from here, which is what bounds a conversation.
      chainHop.set(paneId, head.hop);
      remember(paneId, head);
      return queue.length > 0 ? at + SERIALIZE_MS : null;
    }
  }

  function drain(): void {
    if (disposed) return;
    const at = now();
    let deadline: number | null = null;
    // A notice minted mid-pass belongs to a pane this pass may already have
    // walked, so one more pass is owed. It converges after that: a notice
    // cannot mint another notice (`expiryNotice` refuses).
    for (let pass = 0; pass < 2; pass += 1) {
      noticed = false;
      deadline = null;
      for (const [paneId, queue] of [...queues]) {
        deadline = earlier(deadline, drainPane(paneId, queue, at));
        if (queue.length === 0) queues.delete(paneId);
      }
      if (!noticed) break;
    }
    cancelTimer?.();
    cancelTimer = null;
    if (deadline === null) return;
    // Never below zero, and never zero: a deadline already past would spin
    // the timer against a clock that has not moved.
    cancelTimer = schedule(() => {
      cancelTimer = null;
      drain();
    }, Math.max(1, deadline - at));
  }

  const unsubscribes = [
    deps.subscribeActivity(() => drain()),
    deps.subscribeChannels(() => drain()),
  ];

  return {
    send(request) {
      const inherited = chainHop.get(request.from.paneId) ?? null;
      const verdict = decideSend(request.from, request.toPaneId, inherited, limits);
      if (verdict.kind === "refuse") return { ok: false, refusal: verdict.refusal };
      const mail: Mail = {
        id: mintId(),
        kind: request.kind,
        body: request.body,
        from: { kind: "pane", pane: request.from },
        toPaneId: request.toPaneId,
        at: now(),
        hop: verdict.hop,
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
      };
      enqueue(mail);
      drain();
      // Still queued means it did not land. It cannot have expired — it was
      // minted at `now()` — so "gone from the queue" is exactly "delivered".
      const pending = queues.get(mail.toPaneId);
      const delivered = !pending?.some((queued) => queued.id === mail.id);
      return { ok: true, id: mail.id, delivered };
    },

    announce(paneId, kind, body) {
      enqueue({
        id: mintId(),
        kind,
        body,
        from: { kind: "host" },
        toPaneId: paneId,
        at: now(),
        hop: 0,
      });
      drain();
    },

    takeAtTurnEnd(paneId) {
      const at = now();
      const queue = queues.get(paneId);
      if (!queue) return [];
      const taken: Mail[] = [];
      while (queue.length > 0) {
        const head = queue[0];
        // The clock still rules: a message too old to paste is too old to
        // hand over politely, and its sender is owed the same report.
        if (at - head.at >= limits.undeliveredMs) {
          queue.shift();
          const notice = expiryNotice(head, mintId(), at);
          if (notice) enqueue(notice);
          continue;
        }
        // A permission prompt is about the TERMINAL, and arriving through a
        // hook does not make answering one safe — the pane is still parked
        // where keystrokes pick menu items. Held, exactly as before.
        const activity = deps.activityOf(paneId);
        if (activity?.state === "waiting" && activity.reason === "permission") break;
        queue.shift();
        chainHop.set(paneId, head.hop);
        remember(paneId, head);
        taken.push(head);
      }
      if (queue.length === 0) queues.delete(paneId);
      // Whatever is left (a held prompt, a fresh notice) still needs its
      // timer, and the queue just moved under it.
      drain();
      return taken;
    },

    restore(messages) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const mail = messages[i];
        const queue = queues.get(mail.toPaneId);
        if (queue) queue.unshift(mail);
        else queues.set(mail.toPaneId, [mail]);
        const held = inboxes.get(mail.toPaneId);
        const at = held?.findIndex((seen) => seen.id === mail.id) ?? -1;
        if (held && at >= 0) held.splice(at, 1);
      }
      drain();
    },

    inbox(paneId, since) {
      const held = inboxes.get(paneId) ?? [];
      if (since === undefined) return [...held];
      const index = held.findIndex((mail) => mail.id === since);
      return index < 0 ? [...held] : held.slice(index + 1);
    },

    retain(liveIds) {
      for (const map of [queues, inboxes, chainHop, lastDeliveryAt]) {
        for (const id of [...map.keys()]) {
          if (!liveIds.has(id)) map.delete(id);
        }
      }
    },

    clear(paneId) {
      chainHop.delete(paneId);
      lastDeliveryAt.delete(paneId);
    },

    dispose() {
      disposed = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}
