/**
 * What both of KeepDeck's opencode plugins have to agree about: which session
 * in this process is the pane's conversation.
 *
 * ONE OBJECT, NOT ONE RULE. The rule was shared already — a factory both
 * plugins called — and that was the defect, because a factory hands out a
 * fresh answer to each caller. The reporter kept its own root and its own
 * index, the courier kept another pair, and the two derived the same fact
 * from the same event stream by different paths: one preserved the ancestry
 * on binding, the other cleared it; one told a continuing conversation from a
 * new one, the other took the first answer to arrive. Their comment said
 * "shared with the reporter beside this file", and it described an intention
 * the code did not carry out.
 *
 * Two answers here means mail delivered into a conversation whose turns the
 * deck is not watching — the failure the courier's own comment records as
 * having happened. It has not fired since, because every later read checks
 * against the active root and a stale one is quietly filtered; the drift is
 * guaranteed by the construction rather than by anything observed.
 *
 * ONE INSTANCE PER PROCESS. Both plugins import this module, and a module
 * runs once — measured, not assumed: a birth mark placed here is identical in
 * both, and what one writes the other reads at its own startup. That is the
 * whole mechanism; there is no registry in the plugin input to share through,
 * and had the module been isolated the only ways left would have been the
 * server itself or a file in the pane's directory.
 *
 * EVERY WRITE IS IDEMPOTENT, on purpose. opencode delivers each event to BOTH
 * plugins, so anything either of them tells this object, it may be told
 * twice. Assigning rather than counting, and refusing a generation that is
 * already current, is what makes the second telling harmless — and it is
 * cheaper than teaching this object to recognise an event it has already
 * seen.
 *
 * NOTHING HERE TALKS TO THE SERVER AT CREATION. A plugin whose init waits on
 * a client call deadlocks the TUI: boot waits for the plugin, the plugin
 * waits for a reply that boot has not started serving. Measured — a blank
 * screen. Every request below hangs off an event instead.
 */

/** The one instance, and the client it speaks through. */
let shared;
let sharedClient;

/**
 * This process's pane session.
 *
 * The client is ADOPTED rather than captured: whichever plugin initialises
 * first may have none — the reporter does not treat a missing client as a
 * reason to stay quiet — and a later, fuller one has to be able to take over.
 * Every request below reads it through the holder for that reason; a closure
 * over the first one would leave this permanently unable to ask anything,
 * with an index answering "unknown" forever and nothing to say why.
 */
export function paneSession(client) {
  if (client && !sharedClient) sharedClient = client;
  if (!shared) shared = create();
  return shared;
}

/** Test seam: a fresh process, without one. */
export function resetPaneSession() {
  shared = undefined;
  sharedClient = undefined;
}

function create() {
  /** child session id → its IMMEDIATE parent. One hop each, exactly as the
   * server reports it; `rootOf` walks the links rather than pre-compressing
   * them, so a hop learned later fixes every descendant at once. */
  const parents = new Map();
  /** Sessions confirmed to have no parent. Kept apart from `parents` because
   * "is a root" and "we have not asked" must not look alike: an answer we
   * could not get has to be asked again, and one we got must not be. */
  const roots = new Set();
  /** The pane's conversation, once one is known. */
  let root;
  /** Whether the pane's own turn is running. Assigned, never counted: an
   * abort ends a turn with TWO idles about 19ms apart, and a counter would
   * come out of that below zero. */
  let turnInFlight = false;

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

  /** Every hop from `sessionID` up to its root, as `[child, parent]` pairs.
   * What a new generation is about to destroy, so a caller that still needs
   * the chain can put it back. */
  const chain = (sessionID) => {
    const hops = [];
    let at = sessionID;
    for (let left = parents.size; left > 0 && parents.has(at); left -= 1) {
      hops.push([at, parents.get(at)]);
      at = parents.get(at);
    }
    return hops;
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
      if (!sharedClient?.session?.get) return "unknown";
      let found;
      try {
        found = await sharedClient.session.get({ path: { id: sessionID } });
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
    chain,
    classify,
    get root() {
      return root;
    },
    /**
     * Whether this object has a conversation yet.
     *
     * Asked apart from "is the root empty", because before this is true the
     * pane accepts the first non-child session it sees — a status edge that
     * beats `session.created` should bind the pane rather than strand it. A
     * caller cannot tell an unbound pane from an unfed one by looking at the
     * root alone, and one object serving two plugins has to be able to say
     * which it is.
     */
    get bound() {
      return root !== undefined;
    },
    get turnInFlight() {
      return turnInFlight;
    },
    setTurnInFlight(running) {
      turnInFlight = running;
    },
    /**
     * Take a session as the pane's conversation, KEEPING what is known about
     * its ancestry.
     *
     * For binding through evidence of a descendant: the chain is open at the
     * moment of binding and is this generation's. Clearing it would leave
     * every sibling resolving to itself, failing the root check its events
     * are measured against, and their spend never reaching the pane's total.
     *
     * First answer wins. Two events can both find this unbound and both go
     * away to ask, and the slower one — an unrelated subagent, whose chain
     * takes an extra hop — would otherwise land last and rebind the pane to
     * somebody else's conversation for the life of the process. That happened.
     */
    bindFromChain(sessionID, keep = []) {
      if (root !== undefined || !sessionID) return false;
      root = sessionID;
      for (const [child, parent] of keep) note(child, parent);
      return true;
    },
    /**
     * A NEW root conversation — `/new`, or a fresh pane's first session.
     *
     * Its own generation: nothing from the old one rolls up to it, and the
     * old one's child ids answer about a session that has ended. Refused when
     * it is already the current root, because both plugins see the event that
     * causes it and either may say so.
     */
    newGeneration(sessionID) {
      if (!sessionID || root === sessionID) return false;
      parents.clear();
      roots.clear();
      root = sessionID;
      turnInFlight = false;
      return true;
    },
    /**
     * Whether a session-scoped event describes the PANE's conversation: the
     * active root itself — never a subagent child, whose going busy or idle
     * is not the pane's turn boundary — and any non-child session before a
     * root is known.
     */
    concernsPane(sessionID) {
      if (!sessionID || rootOf(sessionID) !== sessionID) return false;
      return root === undefined || sessionID === root;
    },
  };
}
