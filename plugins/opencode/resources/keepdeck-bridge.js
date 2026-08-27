/**
 * The WIRE both of KeepDeck's opencode plugins speak to the deck — and only
 * the wire.
 *
 * They stay two plugins — the reporter states facts about the pane and asks
 * nothing, the courier carries mail in and is the only one that asks — but
 * they run in the same process and speak the same protocol, and that protocol
 * was written out twice. Every decision here is silent-failure shaped: change
 * the reporter identity rule or the envelope shape in one file and the deck
 * ignores that plugin's postbacks with nothing logged on either side.
 *
 * WHAT the plugins are talking ABOUT lives next door, in `pane-session.js`.
 * It was here, and having the session tree inside the transport meant anyone
 * reaching for `sendEnvelope` also pulled in opencode's idea of a
 * conversation — and, worse, that the thing shared was a factory rather than
 * an object, so each plugin built its own answer to a question they had to
 * agree on.
 *
 * Shipped beside them and imported as a sibling: `build-plugins.mjs` copies
 * `resources/` whole, and opencode loads each plugin by absolute path, so a
 * relative import between them resolves the same way in the repo and in the
 * bundle.
 */
// Built in, like everything else this file leans on: a reporter that needed
// a dependency installed would be a reporter that stops working the moment
// somebody ships without it.
import { request as httpRequest } from "node:http";

/**
 * Which process is reporting, on every lane either plugin publishes.
 *
 * The deck pins a pane's identity to ONE reporting process and refuses the
 * others — the bridge secret is inherited by the pane's whole process tree,
 * so it cannot tell them apart on its own. These run INSIDE the agent, so
 * the agent's own pid is that name, and being two plugins in the SAME
 * process they answer identically. A nested opencode gets its own and is
 * refused. The shell reporters answer the same question with the process
 * group of the hook's parent, since a hook is not the agent.
 */
export const REPORTER = String(process.pid);

/**
 * This pane's bridge, or null when nothing spawned us from KeepDeck.
 *
 * `dir` is the pane's OWN directory. It used to be an inbox this plugin
 * dropped envelopes into; since the cutoff the only thing that lands there is
 * the deck's doorbell, which runs the other way — the surface takes envelopes
 * from panes and cannot push to them, so a knock still needs a file.
 */
export function readBridge() {
  let bridge;
  try {
    bridge = JSON.parse(process.env.KEEPDECK_BRIDGE ?? "");
  } catch {
    return null;
  }
  const { dir, pane, token, url } = bridge ?? {};
  // All four required now. `url` was optional while a reporter that had never
  // heard of it could still write a file; nothing reads those files, so a
  // pane without an address has nowhere to report and should say so by being
  // absent rather than by looking armed.
  return dir && pane && token && typeof url === "string" && url
    ? { dir, pane, token, url }
    : null;
}

/**
 * One envelope, addressed to this pane's deck.
 *
 * Every lane either plugin publishes carries the same five things — the
 * protocol version, the type, the pane, its secret, and who is reporting —
 * and they were written out four times. A wire format spelled once is a wire
 * format that cannot half-change: the deck refuses an envelope whose shape it
 * does not know, and it refuses it silently.
 */
export function makeEnvelope(bridge, type, payload) {
  return {
    v: 2,
    type,
    paneId: bridge.pane,
    token: bridge.token,
    payload: { agent: "opencode", reporter: REPORTER, ...payload },
  };
}

/**
 * Hand one envelope to the deck and wait for what it answers.
 *
 * One lane. There used to be two — this, and dropping a file in a directory
 * the deck watched — and the file was not the worse option kept around: it
 * was the whole transport first, and the only lane a deck too old to publish
 * an address had. It is gone, and with it the reason this plugin had to know
 * how to write an inbox at all.
 *
 * `answer` is the deck's reply when it had one to give, and `null` otherwise.
 * A caller with no question to ask can ignore it entirely.
 *
 * ONLY 200 CARRIES A BODY. What the other codes mean is decided by
 * src-tauri/src/bridge/http.rs and written down there, once; a table repeated
 * here would go on describing the contract after the deck changed it, and
 * nothing holds prose in step. Nothing here would act on the difference
 * anyway: the deck logs its own timeout, on the side that knows something
 * went wrong, and it puts back any messages whose answer reached nobody —
 * because the send tells it so.
 *
 * For a caller that ASKS. A caller that only states a fact wants `publish`
 * below, which keeps the deck's reading of those facts in the order they
 * happened.
 */
export async function sendEnvelope(bridge, envelope) {
  const posted = await post(bridge.url, JSON.stringify(envelope));
  return { answer: posted.status === 200 ? posted.body : null };
}

/**
 * State one fact, in its turn.
 *
 * The bus hands this process its events in one order and that order is the
 * truth — an abort's error is published before the idle that follows it, by
 * the CLI's own code. Two posts fired without waiting lose that: the deck
 * takes each connection on its own thread, so the second can be read first.
 * Measured on the real reporter against a local deck: 3 inversions in 50
 * aborts, on a pair 0-3ms apart. The deck then reads a finished turn where an
 * interrupted one was reported, and absorbs the correction as an echo.
 *
 * So the posts queue. The queue is the WIRE's, not the caller's: the event
 * handler hands its envelope over and returns, exactly as before — what waits
 * is the next post, not the next event. The old comment defended
 * fire-and-forget by saying a turn-lifecycle edge must not wait on a round
 * trip it has nothing to do with, and that is still true of the HANDLER. It
 * was never true of the wire.
 *
 * Nothing is retried and nothing is reported back: a send that fails is one
 * fact the deck never hears, and a caller stating facts has nothing to do
 * about that. A failure must not stall the ones behind it either, which is
 * why the tail swallows.
 */
let outbound = Promise.resolve();
export function publish(bridge, envelope) {
  outbound = outbound.then(() => sendEnvelope(bridge, envelope)).catch(() => {});
}

/** How long to give the whole round trip, matching the shell reporters'
 * `SEND_MAX`: one number for one rule, so no two lanes disagree about it.
 *
 * Deliberately LONGER than the deck's own patience (`HOOK_WAIT` in
 * bridge/waiters.rs), so the deck runs out first and answers 504 rather than
 * leaving this side timing out against a silent socket.
 * `scripts/reporterScripts.test.mjs` pins that ordering. */
const SEND_TIMEOUT_MS = 3000;

/** One POST, resolving to `{ status, body }` — `status` is 0 when nothing
 * answered at all, which since the cutoff means this report is lost. */
function post(url, body) {
  return new Promise((resolve) => {
    let settled = false;
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
