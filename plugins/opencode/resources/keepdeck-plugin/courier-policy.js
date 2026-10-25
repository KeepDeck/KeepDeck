// @ts-check
/**
 * WHERE the courier's mail may go — for either opencode generation's courier.
 *
 * Mail goes only into the conversation the TUI shows (task-435, task-436):
 * a turn started where the user is not looking is work nobody sees. The
 * screen is the follower's to read (`screen()`, follower.js); this decides
 * what the courier does about it, and runs the one delivery that needs more
 * than the pane's session — mail for a pane the user left for the home
 * screen (`viaHome`).
 *
 * What a generation does differently is HOW, handed in as `adapter`:
 *
 *   selectionOf(sessionID)         the agent and model a session's prompts run as
 *   createSession(selection)       a new root session, run as `selection`: its id, or null
 *   show(sessionID)                ask the TUI to show it
 *   deliver(answer, id, selection) put an answer into a session
 *
 * and `deliverToPane()` — the delivery into the pane as it stands, which is
 * also what an unbound pane on opencode's own start gets.
 */
import { drained } from "./keepdeck-bridge.js";

/** How long a session made for the mail may take to come on screen. */
const SHOW_WAIT_MS = 3_000;

/** @typedef {{ root: string | undefined, left: string | undefined, bound: boolean, rootOf: (id: string) => string, classify: (id: string) => Promise<string> }} PaneView */
/** @typedef {{ kind: string, sessionID?: string }} Screen */

/**
 * Whether the pane's conversation is what the TUI shows. Unknown — no
 * trusted observer for the TUI this process serves — means as before there
 * was one. A subagent's
 * view is its conversation's; one not yet known to be is held, not guessed.
 * @param {Screen} screen
 * @param {PaneView} pane
 */
export const visibleOn = (screen, pane) =>
  screen.kind === "unknown" ||
  (screen.kind === "session" && !!screen.sessionID && pane.bound && pane.rootOf(screen.sessionID) === pane.root);

/**
 * @template Selection, Answer
 * @param {{ pane: PaneView, screen: () => Screen, ask: (classification: string) => Promise<Answer | undefined>, adapter: { selectionOf: (id: string) => Promise<Selection>, createSession: (selection: Selection) => Promise<string | null>, show: (id: string) => Promise<unknown>, deliver: (answer: Answer, id: string, selection: Selection) => Promise<unknown> }, deliverToPane: () => Promise<unknown> }} options
 */
export function createCourierPolicy({ pane, screen, ask, adapter, deliverToPane }) {
  /** After a session the TUI did not show, nothing is tried again until the
   * screen changes: the deck re-rings every 45 s, and each ring would make
   * another empty session. */
  let homeFailed = false;
  /** The user started a conversation of their own while `viaHome` ran. */
  let theirs = false;
  /** @type {Set<string>} */
  const ours = new Set();
  /** Root sessions that appeared while `createSession` was in flight —
   * opencode announces the new session BEFORE the call returns (measured
   * live on 1.x, task-444), so which of them is ours is known only after. */
  /** @type {string[] | null} */
  let creating = null;

  /**
   * Mail for a pane the user left for the home screen (`/new`): what the user
   * would do — a session, shown, then the words — and the user sees it.
   *
   * The ORDER is what makes it safe. The session is made and shown first;
   * only once the TUI shows it, and its binding has reached the deck, is the
   * mail asked for — so a session the TUI never showed costs nothing but an
   * empty session, and the deck hands the brief over WITH the mail rather
   * than after it. A conversation the user starts meanwhile is the one on
   * screen; this one stops (`theirs`).
   */
  const viaHome = async () => {
    if (homeFailed || !pane.left) return;
    const chosen = await adapter.selectionOf(pane.left);
    theirs = false;
    creating = [];
    /** @type {string | null} */
    let id = null;
    try {
      id = await adapter.createSession(chosen);
    } finally {
      const appeared = creating;
      creating = null;
      if (id) ours.add(id);
      if (appeared.some((other) => other !== id)) theirs = true;
    }
    if (!id) return;
    if (theirs || screen().kind !== "home") return;
    await adapter.show(id);
    // Shown, and bound: the reporter takes the new session from its own
    // announcement of it.
    const shown = () => {
      const now = screen();
      return now.kind === "session" && now.sessionID === id && pane.root === id;
    };
    for (let waited = 0; !shown() && waited < SHOW_WAIT_MS; waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!shown() || theirs) {
      homeFailed = true;
      return;
    }
    await drained();
    const answer = await ask(await pane.classify(id));
    if (!answer) return;
    try {
      await adapter.deliver(answer, id, chosen);
    } catch {
      // Best-effort: the user's session must survive anything this gets wrong.
    }
  };

  return {
    /** Whether the pane's conversation is on screen now. */
    visible: () => visibleOn(screen(), pane),

    /**
     * Collect, if the session on screen is the pane's.
     *
     * Another session on screen: the follower moves the pane there and the
     * courier is called again (follower.js) — the courier never moves the
     * pane itself. Nothing fresh on screen (a stalled TUI, a plugin's
     * screen): held. The home screen after the user LEFT a conversation: a
     * session is made for the mail (`viaHome`) — but only when the deck RANG
     * (`rung`), which it does only for mail that waits: nothing tells
     * otherwise whether any does, and every `/new` would leave an empty
     * session behind. Before any leaving the home screen is opencode's own
     * start, or the native fork's, and the pane is reached as it always was.
     */
    /** @param {{ rung?: boolean }} [options] */
    async collect({ rung = false } = {}) {
      const now = screen();
      if (now.kind !== "home") homeFailed = false;
      if (visibleOn(now, pane)) return deliverToPane();
      if (now.kind !== "home") return;
      if (pane.left === undefined) return pane.bound ? undefined : deliverToPane();
      if (rung) return viaHome();
    },

    /** A root session appeared — told at once, not in turn: one the user
     * started while `viaHome` is under way must stop it before it shows its
     * own. */
    /** @param {string} sessionID */
    rootAppeared(sessionID) {
      if (ours.has(sessionID)) return;
      if (creating) creating.push(sessionID);
      else theirs = true;
    },

    /** Whether `viaHome` made `sessionID` — its own to deliver into, once it
     * is shown, and it may never be. */
    /** @param {string} sessionID */
    ours: (sessionID) => ours.has(sessionID),
  };
}
