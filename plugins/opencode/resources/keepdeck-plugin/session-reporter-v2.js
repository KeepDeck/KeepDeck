/**
 * KeepDeck session reporter on opencode 2.x — the 2.x twin of
 * session-reporter.js, started by opencode-v2.js.
 *
 * The same three jobs, from 2.x's own events (packages/schema/src/
 * session-event.ts at v2.1.2):
 *  - BINDING: the pane's conversation, as `session.bound`. A root
 *    `session.created` names it; a resumed pane fires none, so its first
 *    session event does, through the pane session's ancestry. The session
 *    the user opens in the TUI moves it there (follower.js); leaving for
 *    the home screen lets it go (leaving.js) — and stops nothing, since 2.x
 *    runs a tab left behind to completion (user decision, task-436).
 *  - STATUS: the turn events, forwarded whole as `agent.status` — what they
 *    MEAN is read in plugins/opencode/src/status.ts, never here. 2.x calls the
 *    payload `data`; it travels as `properties`, the shape 1.x gave it.
 *  - USAGE: `usage.report` in the shape 1.x sends. Totals come from
 *    `session.usage.updated` — a running total per session — summed over the
 *    pane's conversation and its subagents; the context in use is the root's
 *    last finished step (`session.step.ended`); the window, from the model
 *    catalog.
 *
 * Best-effort throughout: nothing here may break the user's session.
 */
import { follower } from "./follower.js";
import { makeEnvelope, publish as publishEnvelope } from "./keepdeck-bridge.js";
import { createLeaving } from "./leaving.js";
import {
  boundReport,
  createWindowCache,
  skipsApprovals,
  tokenCounts,
  usageReport,
} from "./pane-report.js";

export async function startReporterV2({ context, bridge, pane }) {
  /** Whether this pane skips approval prompts (pane-report.js). */
  const SKIPS_APPROVALS = skipsApprovals();

  const publish = (type, payload) => {
    publishEnvelope(bridge, makeEnvelope(bridge, type, payload));
  };

  /** sessionID → its latest running total: `{ tokens, cost }`. */
  const totals = new Map();
  /** The root's last finished step: what its context holds now. */
  let lastStep;
  /** The model the root's latest step ran on: `{ id, providerID }`. */
  let model;
  let sequence = 0;
  /** The conversation this reporter is bound to and set up for. */
  let servedRoot;
  /** Whether it has bound any: every later one is the pane's conversation
   * continuing, never a second startup. */
  let servedAny = false;

  /** A conversation this reporter is not serving: bind it, and start its
   * spend from nothing. `/new` is the pane's conversation continuing under a
   * new id; `switched`, the user opened it in the TUI. */
  const serve = (switched = false) => {
    if (pane.root === undefined || pane.root === servedRoot) return;
    const continuing = servedAny;
    servedRoot = pane.root;
    servedAny = true;
    totals.clear();
    lastStep = undefined;
    model = undefined;
    sequence = 0;
    publish("session.bound", boundReport(servedRoot, continuing, switched));
  };

  /** Whether the TUI reports its screen — then the screen, not the bus,
   * says which conversation an unbound pane has (follower.js): 2.x runs the
   * tabs left behind, and on the home screen after `/new` the pane has none,
   * whichever background tab speaks. */
  const screenDecides = () => follower().screen().kind !== "unknown";

  /** Bind through the evidence of any session this pane's process names —
   * the way a resumed pane, which fires no root `session.created`, is found.
   * Only while nobody reports the screen. */
  const bindThrough = async (sessionID) => {
    if (!sessionID) return;
    if (!pane.bound && !screenDecides()) {
      await pane.classify(sessionID);
      pane.bindFromChain(pane.rootOf(sessionID), pane.chain(sessionID));
    }
    serve();
  };

  /** Whose turn event this is — the only question answered on this side. */
  const belongsHere = (type, data) => {
    if (type.startsWith("session.execution.")) {
      return pane.concernsPane(data.sessionID) && (pane.bound || !screenDecides());
    }
    if (type === "permission.asked" || type === "permission.replied") return !SKIPS_APPROVALS;
    // A form parks the terminal whichever session put it up (see the 1.x
    // reporter's questions): the pane is waiting either way.
    return type === "form.created" || type === "form.replied" || type === "form.cancelled";
  };

  // The model catalog answers `{ location, data: [...] }` on 2.1.2
  // (measured, task-375).
  const contextWindow = createWindowCache(async () => {
    const listed = await context.model.list();
    return (Array.isArray(listed?.data) ? listed.data : []).map((entry) => ({
      providerID: entry?.providerID,
      modelID: entry?.id,
      window: entry?.limit?.context,
    }));
  });

  const report = async () => {
    // Nothing to say about a context until the root has finished a step.
    if (!lastStep || !servedRoot) return;
    const totalsOf = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const { tokens, cost: spent } of totals.values()) {
      const counted = tokenCounts(tokens);
      for (const key of Object.keys(totalsOf)) totalsOf[key] += counted[key];
      cost += typeof spent === "number" ? spent : 0;
    }
    publish(
      "usage.report",
      usageReport({
        sessionId: servedRoot,
        model: model?.id,
        sequence: ++sequence,
        windowTokens: await contextWindow(model?.providerID, model?.id),
        lastTurn: tokenCounts(lastStep),
        totals: totalsOf,
        costUsd: cost,
      }),
    );
  };

  const handle = async (event) => {
    const type = event?.type;
    const data = event?.data ?? {};
    if (typeof type !== "string") return;

    if (type === "session.created") {
      if (data.parentID) {
        pane.note(data.sessionID, data.parentID);
        await bindThrough(data.parentID);
        return;
      }
      pane.newGeneration(data.sessionID);
      serve();
      return;
    }

    if (belongsHere(type, data)) {
      if (type.startsWith("session.execution.")) await bindThrough(data.sessionID);
      publish("agent.status", { event: { type, properties: data } });
      return;
    }

    if (type === "session.step.started" || type === "session.step.ended") {
      await bindThrough(data.sessionID);
      if (data.sessionID !== pane.root) return;
      if (type === "session.step.started") {
        model = data.model;
        return;
      }
      lastStep = data.tokens;
      await report();
      return;
    }

    if (type === "session.usage.updated") {
      await bindThrough(data.sessionID);
      // The pane's conversation and its subagents spend; others do not.
      if (pane.rootOf(data.sessionID) !== pane.root) return;
      totals.set(data.sessionID, { tokens: data.tokens, cost: data.cost });
      await report();
    }
  };

  // A pane resumed into a known session is bound from the start
  // (opencode-v2.js): the deck hears of it now, not at its first event.
  serve();

  // opencode does not wait on a subscriber: one queue keeps two events'
  // async work from interleaving, and an older report from landing last.
  let queue = Promise.resolve();
  const enqueue = (job) => {
    queue = queue.then(job).catch(() => {});
    return queue;
  };

  // The user went home (`/new`): the pane lets go of the conversation at
  // once — no interrupt, the tab runs on. Coming back to it later binds it
  // afresh, so it is no longer the one served.
  const leaving = createLeaving({
    pane,
    publish,
    enqueue,
    onLetGo: () => {
      servedRoot = undefined;
    },
  });
  follower().onLeave(leaving.leave);

  // The user opened another session in the TUI: the binding first, as one
  // job in this queue, so the deck hears of it before any of its events.
  follower().onMove((sessionID) =>
    enqueue(async () => {
      pane.newGeneration(sessionID);
      serve(true);
    }),
  );

  return {
    onEvent: (event) => {
      void enqueue(() => handle(event));
    },
  };
}
