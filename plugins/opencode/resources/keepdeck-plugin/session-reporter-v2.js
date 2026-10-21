/**
 * KeepDeck session reporter on opencode 2.x — the 2.x twin of
 * session-reporter.js, started by opencode-v2.js.
 *
 * The same three jobs, from 2.x's own events (packages/schema/src/
 * session-event.ts at v2.1.2):
 *  - BINDING: the pane's conversation, as `session.bound`. A root
 *    `session.created` names it; a resumed pane fires none, so its first
 *    session event does, through the pane session's ancestry.
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
import { makeEnvelope, publish as publishEnvelope } from "./keepdeck-bridge.js";

export async function startReporterV2({ context, bridge, pane }) {
  /** Whether this pane skips approval prompts — the deck's choice at spawn,
   * stated here because it cannot be discovered from inside (see the 1.x
   * reporter for what an auto-answered prompt looked like on the deck). */
  const SKIPS_APPROVALS = process.env.KEEPDECK_OPENCODE_SKIPS_APPROVALS === "1";

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
  /** The conversation this reporter last bound and set up for. */
  let servedRoot;

  /** A conversation this reporter has not served yet: bind it, and start its
   * spend from nothing. `/new` is the pane's conversation continuing under a
   * new id, so a second one is reported as continuing. */
  const serve = () => {
    if (pane.root === undefined || pane.root === servedRoot) return;
    const continuing = servedRoot !== undefined;
    servedRoot = pane.root;
    totals.clear();
    lastStep = undefined;
    model = undefined;
    sequence = 0;
    publish("session.bound", {
      sessionId: servedRoot,
      source: continuing ? "new" : "startup",
    });
  };

  /** Bind through the evidence of any session this pane's process names —
   * the way a resumed pane, which fires no root `session.created`, is found. */
  const bindThrough = async (sessionID) => {
    if (!sessionID) return;
    if (!pane.bound) {
      await pane.classify(sessionID);
      pane.bindFromChain(pane.rootOf(sessionID), pane.chain(sessionID));
    }
    serve();
  };

  /** Whose turn event this is — the only question answered on this side. */
  const belongsHere = (type, data) => {
    if (type.startsWith("session.execution.")) return pane.concernsPane(data.sessionID);
    if (type === "permission.asked" || type === "permission.replied") return !SKIPS_APPROVALS;
    // A form parks the terminal whichever session put it up (see the 1.x
    // reporter's questions): the pane is waiting either way.
    return type === "form.created" || type === "form.replied" || type === "form.cancelled";
  };

  // (providerID, modelID) → window, from the catalog, cached once found.
  const windows = new Map();
  const contextWindow = async (ref) => {
    if (!ref) return undefined;
    const key = `${ref.providerID}\0${ref.id}`;
    if (windows.has(key)) return windows.get(key);
    try {
      // `{ location, data: [...] }` on 2.1.2 (measured, task-375).
      const listed = await context.model.list();
      const found = (Array.isArray(listed?.data) ? listed.data : []).find(
        (entry) => entry?.id === ref.id && entry?.providerID === ref.providerID,
      );
      const window = found?.limit?.context;
      if (typeof window === "number") windows.set(key, window);
      return typeof window === "number" ? window : undefined;
    } catch {
      return undefined;
    }
  };

  const tokensOf = (value) => ({
    input: value?.input ?? 0,
    output: value?.output ?? 0,
    reasoning: value?.reasoning ?? 0,
    cacheRead: value?.cache?.read ?? 0,
    cacheWrite: value?.cache?.write ?? 0,
  });

  const report = async () => {
    // Nothing to say about a context until the root has finished a step.
    if (!lastStep || !servedRoot) return;
    const sum = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0;
    for (const { tokens, cost: spent } of totals.values()) {
      const counted = tokensOf(tokens);
      for (const key of Object.keys(sum)) sum[key] += counted[key];
      cost += typeof spent === "number" ? spent : 0;
    }
    const turn = tokensOf(lastStep);
    const windowTokens = await contextWindow(model);
    publish("usage.report", {
      sessionId: servedRoot,
      ...(model ? { model: model.id } : {}),
      sequence: ++sequence,
      ...(windowTokens !== undefined ? { windowTokens } : {}),
      contextTokens:
        turn.input + turn.output + turn.reasoning + turn.cacheRead + turn.cacheWrite,
      totals: sum,
      lastTurn: turn,
      costUsd: cost,
    });
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

  // opencode does not wait on a subscriber: one queue keeps two events'
  // async work from interleaving, and an older report from landing last.
  let queue = Promise.resolve();
  return {
    onEvent: (event) => {
      queue = queue.then(() => handle(event)).catch(() => {});
    },
  };
}
