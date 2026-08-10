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
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * `dir` is the pane's OWN inbox — one directory per pane, so an answer is
 * addressed by pane and a correlation naming somebody else's reaches nobody.
 */
export function readBridge() {
  let bridge;
  try {
    bridge = JSON.parse(process.env.KEEPDECK_BRIDGE ?? "");
  } catch {
    return null;
  }
  const { dir, pane, token } = bridge ?? {};
  return dir && pane && token ? { dir, pane, token } : null;
}

/**
 * Atomically drop one envelope into the inbox: uniquely named (so parallel
 * events never collide), written as `.tmp` and renamed, so the deck's
 * watcher never reads a torn file. Answers whether it landed.
 *
 * Best-effort like everything on this path — a full disk must not break the
 * user's session.
 */
export function publish(dir, envelope) {
  try {
    const base = join(dir, `${envelope.type}-${randomUUID()}`);
    writeFileSync(`${base}.tmp`, JSON.stringify(envelope));
    renameSync(`${base}.tmp`, `${base}.json`);
    return true;
  } catch {
    return false;
  }
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
 */
export function createSubagentIndex(client) {
  /** child session id → the root its work belongs to. */
  const parents = new Map();
  return {
    /** Record a child seen being created, with the root it rolls up to —
     * a child's own children roll up to the same root, not to their parent. */
    note(childID, parentID) {
      if (childID) parents.set(childID, parents.get(parentID) ?? parentID);
    },
    /** The root this session's work belongs to, itself if it is a root. */
    rootOf: (sessionID) => parents.get(sessionID) ?? sessionID,
    /** Whether this session is a subagent's. Asks the server the first time
     * it meets an id it did not watch being created. */
    async isChild(sessionID) {
      if (!sessionID) return false;
      if (parents.has(sessionID)) return true;
      if (!client?.session?.get) return false;
      try {
        const found = await client.session.get({ path: { id: sessionID } });
        const parentID = found?.data?.parentID;
        if (!parentID) return false;
        this.note(sessionID, parentID);
        return true;
      } catch {
        return false;
      }
    },
    /** Forget everything: a new root conversation (`/new`) owns a new
     * generation, and nothing from the old one rolls up to it. */
    clear() {
      parents.clear();
    },
  };
}
