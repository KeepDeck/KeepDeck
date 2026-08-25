/**
 * What both of KeepDeck's opencode plugins need to talk to the deck.
 *
 * They stay two plugins — the reporter states facts about the pane and asks
 * nothing, the courier carries mail in and is the only one that asks — but
 * they run in the same process and speak the same wire, and that wire was
 * written out twice. Three of the four decisions here are silent-failure
 * shaped: change the reporter identity rule or the envelope filename in one
 * file and the deck ignores that plugin's postbacks with nothing logged on
 * either side.
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
 * Hand one envelope to the deck.
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
 */
export async function sendEnvelope(bridge, envelope) {
  const posted = await post(bridge.url, JSON.stringify(envelope));
  return { answer: posted.status === 200 ? posted.body : null };
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

/**
 * Which sessions in this process are SUBAGENTS rather than the pane's own
 * conversation.
 *
 * opencode's task tool creates child sessions in the same process, firing
 * the same events with `parentID` set. Both plugins have to tell them apart
 * and they must agree: the reporter binds the pane to a session and reports
 * its turn boundaries, the courier delivers mail into one. Two answers means
 * mail arriving in a conversation whose turns the deck is not watching — or,
 * worse, in a subagent's leaf that ends and takes the messages with it.
 *
 * Both had their own copy, and they were not the same rule: one asked the
 * server, the other only remembered the children it happened to watch being
 * created. A pane RESUMED mid-task (`-s <id>`, how every pane comes back
 * after a restart) sees a child's events before any root's, so the
 * remembering copy adopted a subagent as the pane.
 *
 * Asked rather than assumed, once per session id and then remembered — the
 * answer cannot change. When the client cannot answer, the session is
 * treated as a root: leaving the pane bound to nothing is worse than binding
 * to the wrong one, because nothing ever reaches it again.
 *
 * Every member is a closure rather than a method: this object gets passed
 * between two plugins, and a `this`-bound method breaks the moment somebody
 * destructures it.
 */
export function createSubagentIndex(client) {
  /** child session id → its IMMEDIATE parent. One hop each, exactly as the
   * server reports it; `rootOf` walks the links rather than pre-compressing
   * them, so a hop learned later fixes every descendant at once. */
  const parents = new Map();
  /** Sessions confirmed to have no parent. Kept apart from `parents` because
   * "is a root" and "we have not asked" must not look alike: an answer we
   * could not get has to be asked again, and one we got must not be. */
  const roots = new Set();

  /** Record one hop the caller already knows — a `session.created` carrying
   * `parentID` is the server's own word, and needs no round trip. */
  const note = (childID, parentID) => {
    if (childID && parentID) parents.set(childID, parentID);
  };

  /** Walk to the end of the chain. An id with no recorded parent is as far
   * as this index can see; whether that is a root or merely unasked is the
   * caller's question, answered by `classify`. */
  const rootOf = (sessionID) => {
    let at = sessionID;
    // Bounded by the map: every step consumes one recorded link, and a link
    // is only ever written for a child, so a cycle cannot outlive the count.
    for (let hops = parents.size; hops > 0 && parents.has(at); hops -= 1) {
      at = parents.get(at);
    }
    return at;
  };

  /**
   * Ask the server about one session and record what it says, walking up
   * until the chain reaches something already known.
   *
   * The generated client a plugin is handed RESOLVES with `{error}` rather
   * than throwing — measured on 1.18.15, and spelled out in both plugins —
   * so a `catch` alone sees nothing. An unanswerable id is recorded NOWHERE,
   * which is what makes the next call ask again instead of inheriting a
   * guess.
   *
   * In flight per id, so two events racing on the same session make one
   * request and get the same answer.
   */
  const pending = new Map();
  const ask = (sessionID) => {
    const already = pending.get(sessionID);
    if (already) return already;
    const work = (async () => {
      if (!client?.session?.get) return "unknown";
      let found;
      try {
        found = await client.session.get({ path: { id: sessionID } });
      } catch {
        return "unknown";
      }
      if (!found || found.error || !found.data?.id) return "unknown";
      const parentID = found.data.parentID;
      if (!parentID) {
        roots.add(sessionID);
        return "root";
      }
      note(sessionID, parentID);
      // The parent may itself be a subagent this index has never met. One hop
      // is not enough on a pane resumed mid-task, where the whole chain
      // arrives unseen — and stopping early roots the pane in a leaf.
      await classify(parentID);
      return "child";
    })().finally(() => pending.delete(sessionID));
    pending.set(sessionID, work);
    return work;
  };

  /** Whether this session is a subagent's. `"root"` and `"child"` are
   * answers; `"unknown"` means the client could not say, and is remembered
   * nowhere so the next caller asks again. Both callers treat `"unknown"` as
   * a root — a pane bound to nothing is never reachable again — but they do
   * so out loud rather than by having it look like one. */
  const classify = async (sessionID) => {
    if (!sessionID) return "unknown";
    if (roots.has(sessionID)) return "root";
    if (parents.has(sessionID)) {
      // Known to be a child, but its ancestors may not be. Resolving now is
      // what stops `rootOf` stopping at a middle link.
      const top = rootOf(sessionID);
      if (top !== sessionID && !roots.has(top)) await classify(top);
      return "child";
    }
    return ask(sessionID);
  };

  return {
    note,
    rootOf,
    classify,
    /** Every hop from `sessionID` up to its root, as `[child, parent]` pairs.
     * What `clear` is about to destroy, so a caller that still needs the
     * chain can put it back. */
    chain: (sessionID) => {
      const hops = [];
      let at = sessionID;
      for (let left = parents.size; left > 0 && parents.has(at); left -= 1) {
        hops.push([at, parents.get(at)]);
        at = parents.get(at);
      }
      return hops;
    },
    /** Forget everything: a new root conversation (`/new`) owns a new
     * generation, and nothing from the old one rolls up to it. */
    clear: () => {
      parents.clear();
      roots.clear();
    },
  };
}
