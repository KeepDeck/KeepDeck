/**
 * The watch that notices a continuation whose start has gone quiet.
 *
 * Resuming or forking a session normally paints within a couple of seconds.
 * When it does not, the pane looks exactly the same as one that is merely
 * slow — a spinner with nothing behind it — and a person has no way to tell
 * a working start from a stuck one. This watch owns that distinction: it
 * knows which panes are waiting, when each began, and when a wait has gone on
 * long enough to be worth saying out loud.
 *
 * It publishes the MOMENT the wait began, never the elapsed time. Three
 * transitions per wait at most — it starts, it turns slow, it ends — so
 * counting the seconds is the view's job and costs the application nothing.
 */
import type { SessionRegistryPort } from ".";
import type { RunViewStore } from "./view";

/**
 * How long a continuation may stay silent before the pane says so.
 *
 * From measurement, with room to spare: the slowest agent's first byte after
 * a resume was around 2.4 seconds in a terminal that answers capability
 * queries, so ten seconds is roughly four times the slowest healthy start.
 * It is a policy of this scenario, not a rule about sessions — the point is
 * to be well clear of normal, not to be precise about it.
 */
export const SLOW_START_MS = 10_000;

/** How often the wait is re-examined. Only the lag before a hint appears or
 * clears; the seconds a person sees are counted in the view. */
const TICK_MS = 1_000;

export interface StartupSilenceWatch {
  /** Start watching a pane that has just been asked to continue a session.
   *
   * There is no matching "stop watching": every way a wait can end — the pane
   * paints, the process dies, the spawn fails, the pane closes — is already
   * visible in what the registry says about it, so the watch lets go on its
   * own. A second way to end a wait would be a second answer to when a wait
   * is over. */
  arm(paneId: string): void;
}

export interface StartupSilenceDeps {
  sessions: Pick<SessionRegistryPort, "isLaunched" | "state">;
  view: Pick<RunViewStore, "markStartup" | "startupNote" | "clearStartup">;
  publish(): void;
  now(): number;
  /** Injected so a test drives the ticker rather than waiting for it. */
  startTicker(tick: () => void, everyMs: number): () => void;
}

export function createStartupSilenceWatch(
  deps: StartupSilenceDeps,
): StartupSilenceWatch {
  const { sessions, view, publish, now, startTicker } = deps;
  /** paneId → when its wait began. */
  const waiting = new Map<string, number>();
  let stopTicker: (() => void) | null = null;

  /** A wait is over the moment the pane paints, or stops having a process to
   * wait for at all — an exit, a failed spawn, or a close. */
  function settled(paneId: string): boolean {
    if (sessions.isLaunched(paneId)) return true;
    const kind = sessions.state(paneId).kind;
    return kind !== "starting" && kind !== "live";
  }

  function forget(paneId: string): boolean {
    waiting.delete(paneId);
    if (waiting.size === 0) {
      stopTicker?.();
      stopTicker = null;
    }
    return view.clearStartup(paneId);
  }

  function tick(): void {
    let changed = false;
    for (const [paneId, since] of [...waiting]) {
      if (settled(paneId)) {
        changed = forget(paneId) || changed;
        continue;
      }
      if (now() - since < SLOW_START_MS) continue;
      if (view.startupNote(paneId)?.slow) continue;
      view.markStartup(paneId, { since, slow: true });
      changed = true;
    }
    if (changed) publish();
  }

  return {
    arm(paneId) {
      // Re-arming an already-watched pane would restart its clock, and a
      // reconcile pass can revisit the same pane while it is still starting.
      if (waiting.has(paneId)) return;
      const since = now();
      waiting.set(paneId, since);
      view.markStartup(paneId, { since, slow: false });
      publish();
      stopTicker ??= startTicker(tick, TICK_MS);
    },
  };
}
