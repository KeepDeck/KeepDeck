/**
 * The pane follows the TUI (opencode 1.x, task-435): when the user opens
 * another session — `/sessions`, or opencode's own navigation — that session
 * becomes the pane's conversation.
 *
 * ONE FOLLOWER PER PROCESS, like the pane session it moves: both components
 * join it, and it alone decides that the pane moves. The courier never moves
 * the pane itself.
 *
 * THE ORDER IS THE POINT. Moving the pane is one job in the REPORTER's queue
 * — the new root, the binding, the spend — so the deck learns of the move
 * before any of the new session's events, which it would otherwise wipe on
 * accepting the binding. Then everything published must actually have gone
 * out (`drained`): the courier's ask is not on that queue and would overtake
 * the binding. Only then is the courier told, and it collects for the session
 * now on screen.
 *
 * A subagent's view is the same conversation: the pane follows its root. A
 * session the client cannot classify does not move the pane — following a
 * leaf would bind the pane to somebody else's turn.
 */
import { drained, readBridge } from "./keepdeck-bridge.js";
import { watchForeground } from "./foreground.js";
import { paneSession } from "./pane-session.js";

let shared;

/** The process's follower. */
export function follower() {
  if (!shared) shared = create();
  return shared;
}

function create() {
  /** The reporter's move: one job in its queue, resolved once done. */
  let move;
  /** Told after a move has reached the deck. */
  const settled = [];
  let chain = Promise.resolve();
  let started = false;

  const follow = async (state) => {
    if (state.kind !== "session") return;
    const pane = paneSession();
    const kind = await pane.classify(state.sessionID);
    if (kind === "unknown") return;
    const root = kind === "child" ? pane.rootOf(state.sessionID) : state.sessionID;
    if (root === pane.root) return;
    if (move) await move(root);
    else pane.newGeneration(root);
    await drained();
    for (const listener of settled) listener(root);
  };

  return {
    /** The reporter's half: move the pane to `root`, as one job. */
    onMove(handler) {
      move = handler;
    },
    /** The courier's half: the pane moved and the deck knows. */
    onSettled(listener) {
      settled.push(listener);
    },
    /** Watch the TUI's route — once, after both components joined. Changes
     * are followed one at a time, in the order they happened. */
    start(dir = readBridge()?.dir) {
      if (started || !dir) return;
      started = true;
      watchForeground(dir, (state) => {
        chain = chain.then(() => follow(state)).catch(() => {});
      });
    },
  };
}
