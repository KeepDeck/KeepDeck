// @ts-check
/**
 * opencode's adapter onto the wire both components of KeepDeck's opencode
 * plugin speak to the deck (keepdeck-wire.js, shared with every in-process reporter).
 *
 * They stay two components — the reporter states facts about the pane and
 * asks nothing, the courier carries mail in and is the only one that asks —
 * but they run in the same process and speak the same protocol, and that
 * protocol was written out twice. Every decision here is silent-failure
 * shaped: change the reporter identity rule or the envelope shape in one file
 * and the deck ignores that component's postbacks with nothing logged on
 * either side.
 *
 * WHAT the components are talking ABOUT lives next door, in `pane-session.js`.
 * It was here, and having the session tree inside the transport meant anyone
 * reaching for `sendEnvelope` also pulled in opencode's idea of a
 * conversation — and, worse, that the thing shared was a factory rather than
 * an object, so each component built its own answer to a question they had to
 * agree on.
 *
 * Shipped beside them and imported as a sibling: `build-plugins.mjs` copies
 * `resources/` whole, and opencode loads the plugin directory by absolute
 * path, so a relative import between them resolves the same way in the repo
 * and in the bundle.
 */
// Built in, like everything else this file leans on: a reporter that needed
// a dependency installed would be a reporter that stops working the moment
// somebody ships without it.
import { request as httpRequest } from "node:http";
// The wire itself — envelope, ask, ordered publishing — is shared with every
// in-process reporter; this file is only opencode's adapter onto it: Node's
// environment, Node's HTTP, this process's pid.
import { createWire, parseBridge, SEND_TIMEOUT_MS } from "./keepdeck-wire.js";

/** @typedef {{ dir: string, pane: string, token: string, url: string }} Bridge */
/** @typedef {{ v: number, type: string, paneId: string, token: string, payload: Record<string, unknown> }} Envelope */
/** @typedef {{ bridge: Bridge, makeEnvelope: (type: string, payload: Record<string, unknown>) => Envelope, send: (envelope: Envelope) => Promise<{ answer: string | null, accepted: boolean }>, publish: (envelope: Envelope) => Promise<{ answer: string | null, accepted: boolean }>, drained: () => Promise<void> }} Wire */

/**
 * Which process is reporting, on every lane either plugin publishes.
 *
 * The deck pins a pane's identity to ONE reporting process and refuses the
 * others — the bridge secret is inherited by the pane's whole process tree,
 * so it cannot tell them apart on its own. These run INSIDE the agent, so
 * the agent's own pid is that name, and being two components in the
 * SAME process they answer identically. A nested opencode gets its own and is
 * refused. The shell reporters answer the same question with the process
 * group of the hook's parent, since a hook is not the agent.
 */
export const REPORTER = String(process.pid);

/** This pane's bridge, or null when nothing spawned us from KeepDeck. */
export function readBridge() {
  return parseBridge(process.env.KEEPDECK_BRIDGE);
}

/**
 * The pane's ONE wire. Both components reach it through this module, so they
 * share its publish queue — the order facts are stated in is the process's,
 * not each component's. That holds only while they are ONE plugin: opencode
 * 2.x gives each plugin entry its own copy of a sibling module (see index.js).
 */
/** @type {Wire | null} */
let wire = null;
/** @param {Bridge} bridge @returns {Wire} */
function wireFor(bridge) {
  if (wire === null || wire.bridge.url !== bridge.url || wire.bridge.token !== bridge.token) {
    wire = createWire({ bridge, agent: "opencode", reporter: REPORTER, post });
  }
  return wire;
}

/** One envelope, addressed to this pane's deck.
 * @param {Bridge} bridge
 * @param {string} type
 * @param {Record<string, unknown>} payload
 */
export function makeEnvelope(bridge, type, payload) {
  return wireFor(bridge).makeEnvelope(type, payload);
}

/** Hand one envelope to the deck and wait for what it answers — for a caller
 * that ASKS. A caller that only states a fact wants `publish`.
 * @param {Bridge} bridge
 * @param {Envelope} envelope
 */
export function sendEnvelope(bridge, envelope) {
  return wireFor(bridge).send(envelope);
}

/** State one fact, in its turn (see the wire's `publish`).
 * @param {Bridge} bridge
 * @param {Envelope} envelope
 */
export function publish(bridge, envelope) {
  wireFor(bridge).publish(envelope);
}

/** Settles once every envelope handed to `publish` so far has been sent, or
 * failed and been swallowed. */
export function drained() {
  return wire?.drained() ?? Promise.resolve();
}

/** One POST, resolving to `{ status, body }` — `status` is 0 when nothing
 * answered at all, which means this report is lost.
 * @param {string} url
 * @param {string} body
 * @returns {Promise<{ status: number, body: string }>}
 */
function post(url, body) {
  return new Promise((resolve) => {
    let settled = false;
    /** @param {{ status: number, body: string }} value */
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const request = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => done({ status: response.statusCode ?? 0, body: text }));
          response.on("error", () => done({ status: 0, body: "" }));
        },
      );
      request.setTimeout(SEND_TIMEOUT_MS, () => {
        request.destroy();
        done({ status: 0, body: "" });
      });
      request.on("error", () => done({ status: 0, body: "" }));
      request.end(body);
    } catch {
      done({ status: 0, body: "" });
    }
  });
}
