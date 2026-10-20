// GENERATED from resources/reporters/keepdeck-wire.js — do not edit this copy.
// Edit the canonical file and run `node scripts/sync-reporters.mjs`;
// scripts/reporterScripts.test.mjs fails while a copy is stale.
/**
 * The wire every in-process KeepDeck reporter speaks to the deck — and only
 * the wire.
 *
 * A reporter that runs INSIDE an agent (opencode's plugins, claude's Mod)
 * states the same facts in the same envelope to the same address as the
 * shell hooks do, and every decision here is silent-failure shaped: change
 * the envelope or the reporter rule in one copy and the deck ignores that
 * agent's postbacks with nothing logged on either side. So the rule is
 * written once, and each agent's adapter supplies only what its runtime
 * spells differently — how to read the environment and how to POST.
 *
 * Nothing here may name a runtime: opencode runs it under Node, claude's Mod
 * has no `process`, no `require` and no global `fetch`. A copy of this file
 * ships beside each adapter (scripts/sync-reporters.mjs), because neither
 * host lets a plugin import from outside its own directory.
 */

/** The bridge protocol these envelopes speak — the deck refuses others. */
export const BRIDGE_PROTOCOL = 2;

/** How long to give the whole round trip, matching the shell reporters'
 * `SEND_MAX`: one number for one rule, so no two lanes disagree about it.
 *
 * Deliberately LONGER than the deck's own patience (`HOOK_WAIT` in
 * bridge/waiters.rs), so the deck runs out first and answers 504 rather than
 * leaving this side timing out against a silent socket.
 * `scripts/reporterScripts.test.mjs` pins that ordering. */
export const SEND_TIMEOUT_MS = 3000;

/**
 * This pane's bridge from the raw `KEEPDECK_BRIDGE` value, or null when
 * nothing spawned the agent from KeepDeck.
 *
 * `dir` is the pane's OWN directory; the only thing that lands there is the
 * deck's doorbell, which runs the other way — the surface takes envelopes
 * from panes and cannot push to them, so a knock still needs a file. All four
 * fields are required: a pane without an address has nowhere to report and
 * should say so by being absent rather than by looking armed.
 */
export function parseBridge(raw) {
  let bridge;
  try {
    bridge = JSON.parse(raw ?? "");
  } catch {
    return null;
  }
  const { dir, pane, token, url } = bridge ?? {};
  return dir && pane && token && typeof url === "string" && url
    ? { dir, pane, token, url }
    : null;
}

/**
 * One pane's wire.
 *
 * - `agent`: the agent id every payload carries — the deck checks it against
 *   the pane's own agent.
 * - `reporter`: which process is reporting. The deck pins a pane to ONE
 *   reporting process and refuses the others — the bridge secret is inherited
 *   by the pane's whole process tree, so it cannot tell them apart on its own.
 * - `post(url, body)`: one POST, resolving to `{ status, body }` with `status`
 *   0 when nothing answered; it gives up after `SEND_TIMEOUT_MS`. A post that
 *   throws or rejects counts as nothing answering.
 */
export function createWire({ bridge, agent, reporter, post }) {
  /** One envelope, addressed to this pane's deck. Every lane carries the same
   * five things — the protocol, the type, the pane, its secret, and who is
   * reporting — spelled once so the format cannot half-change. */
  const makeEnvelope = (type, payload) => ({
    v: BRIDGE_PROTOCOL,
    type,
    paneId: bridge.pane,
    token: bridge.token,
    payload: { agent, reporter, ...payload },
  });

  /**
   * Hand one envelope to the deck and wait for what it answers: `answer` is
   * the deck's reply when it had one, and `null` otherwise; `accepted` says
   * whether the deck took the envelope at all. A refusal (403) means the
   * sender is not this pane's — a process that detached from the pane's
   * terminal and kept its environment — and nothing it says will count.
   *
   * ONLY 200 CARRIES A BODY. What the other codes mean is decided by
   * src-tauri/src/bridge/http.rs and written down there, once; nothing here
   * would act on the difference anyway — the deck logs its own timeout and
   * puts back any messages whose answer reached nobody.
   */
  const send = async (envelope) => {
    let posted;
    try {
      posted = await post(bridge.url, JSON.stringify(envelope));
    } catch {
      posted = null;
    }
    const status = posted?.status ?? 0;
    return {
      answer: status === 200 ? posted.body : null,
      accepted: status >= 200 && status < 300,
    };
  };

  /**
   * State one fact, in its turn.
   *
   * The agent hands its reporter events in one order and that order is the
   * truth; two posts fired without waiting lose it, because the deck takes
   * each connection on its own thread and the second can be read first
   * (measured: 3 inversions in 50 aborts on a pair 0-3ms apart). So the posts
   * queue — the WIRE waits, not the caller, which hands its envelope over and
   * returns. Nothing is retried; a failure must not stall the ones behind it.
   *
   * Resolves to what `send` answered for this envelope, for the caller that
   * wants to know — still in its turn, so asking does not reorder anything.
   */
  let outbound = Promise.resolve();
  const publish = (envelope) => {
    const sent = outbound.then(() => send(envelope));
    outbound = sent.catch(() => {});
    return sent;
  };

  /** Settles once every envelope handed to `publish` so far has been sent or
   * failed — for a reader that wants what was reported without guessing at
   * quiet. */
  const drained = () => outbound;

  return { bridge, makeEnvelope, send, publish, drained };
}
