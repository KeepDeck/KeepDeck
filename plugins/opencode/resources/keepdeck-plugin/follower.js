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
 *
 * LEAVING is told to the reporter, which decides what it costs the session
 * left (leaving.js): on 1.x it is aborted (user decision, task-435), on 2.x
 * — a tab per session — it runs on (task-436).
 * Only a real leaving counts: a move to the home screen FROM a session this
 * process showed. opencode starts on the home screen and opens `-s` a beat
 * later, and the native `--fork` fallback stays there until the fork exists
 * (measured, task-443) — neither is the user going anywhere.
 */
import { drained, readBridge } from "./keepdeck-bridge.js";
import { readForeground, watchForeground } from "./foreground.js";
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
  /** The reporter's leaving: what leaving costs the session left, and the
   * pane letting go of it (leaving.js). Resolves once done. */
  let leave;
  /** The last screen this process showed that was a session or the home
   * screen — what a home screen is a move FROM. */
  let lastScreen;
  /** Told after a move has reached the deck. ONE of each, like the move and
   * the leaving: opencode can run a plugin's `server` twice in one process
   * (with `--port`, measured), and two couriers answering one move would ask
   * twice. The latest to join is the one told. */
  let settled;
  let chain = Promise.resolve();
  let started = false;
  /** The TUI this process serves: its pid, and the bridge dir it writes to. */
  let owner = process.pid;
  let watched;

  const tell = async () => {
    await drained();
    settled?.();
  };

  const follow = async (state) => {
    if (state.kind !== "session" && state.kind !== "home") return;
    const from = lastScreen;
    lastScreen = state.kind;
    const pane = paneSession();
    if (state.kind === "home") {
      if (from !== "session" || !pane.bound) return;
      if (leave) await leave(pane.root);
      await tell();
      return;
    }
    const kind = await pane.classify(state.sessionID);
    if (kind === "unknown") return;
    const root = kind === "child" ? pane.rootOf(state.sessionID) : state.sessionID;
    if (root === pane.root) return;
    // Another conversation: the one on screen until now is left behind.
    if (leave && pane.bound) await leave(pane.root, { replaced: true });
    if (move) await move(root);
    else pane.newGeneration(root);
    await tell();
  };

  return {
    /** The reporter's half: move the pane to `root`, as one job. */
    onMove(handler) {
      move = handler;
    },
    /** The reporter's half: the user left `sessionID` — for another
     * conversation (`replaced`), or for none. */
    onLeave(handler) {
      leave = handler;
    },
    /** The courier's half: the pane moved or was left, and the deck knows. */
    onSettled(listener) {
      settled = listener;
    },
    /** What the TUI shows now, read as the follower reads it — the courier
     * asks here rather than naming the TUI's pid itself. */
    screen() {
      const dir = watched ?? readBridge()?.dir;
      return dir ? readForeground(dir, Date.now(), owner) : { kind: "unknown" };
    },
    /** Watch the route of the TUI `tui` (its pid) — once, after both
     * components joined. Changes are followed one at a time, in the order
     * they happened. Returns the stop. */
    start(dir = readBridge()?.dir, tui = process.pid) {
      if (started || !dir) return () => {};
      started = true;
      watched = dir;
      owner = tui;
      return watchForeground(
        dir,
        (state) => {
          chain = chain.then(() => follow(state)).catch(() => {});
        },
        owner,
      );
    },
  };
}
