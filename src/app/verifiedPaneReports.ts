import { log } from "../ipc/log";
import type { DeckStore } from "./deckStore";
import { paneMembership, paneMembershipKey } from "./paneMembership";
import { paneSessionState } from "./ptyManager";
import { peekPaneSpawnSpec } from "./spawnSpecs";
import { postbackAccepted } from "./sessionBinding";

/** The wire shape both bridge report channels share (usage, status). */
export interface PaneReportEvent {
  paneId: string;
  token: string;
  payload: unknown;
}

export interface VerifiedPaneReportsOptions {
  /** The log noun ("usage report", "status report") — rejections must say
   * which lane dropped what. */
  label: string;
  /** Subscribe to the lane's ipc event; resolves to the unlisten. */
  subscribe: (
    handler: (report: PaneReportEvent) => void,
  ) => Promise<() => void>;
  /** Also require the pane's PROCESS to be up (spawning counts — a hook can
   * beat the spawn promise's resolution by milliseconds). Activity is a
   * claim about a live process, so its lane requires this; usage describes
   * the session and account, which outlive the process, so its lane does
   * not — a tail's final token_count after a crash is still true. */
  requireLiveProcess?: boolean;
  /** Apply one verified report. */
  apply: (paneId: string, payload: unknown) => void;
}

export interface VerifiedPaneReports {
  dispose(): void;
}

/**
 * The one home of "who may report for a pane" — the session-binding rule
 * applied to a report lane: the pane must be in the deck, the envelope must
 * echo the per-spawn bridge secret, and (per lane) the process must be
 * alive. Both bridge lanes verify HERE; a guard growing a condition in one
 * lane but not the other is exactly how a retired generation would keep
 * reporting through the weaker one.
 */
export function createVerifiedPaneReports(
  deck: DeckStore,
  options: VerifiedPaneReportsOptions,
): VerifiedPaneReports {
  const { label, requireLiveProcess, apply } = options;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void options
    .subscribe(({ paneId, token, payload }) => {
      if (disposed) return;
      const livePanes = paneMembership(
        paneMembershipKey(deck.getSnapshot()),
      );
      if (!livePanes.has(paneId)) {
        log.warn(
          "web:bridge",
          `${label} for closed pane ${paneId} — ignored`,
        );
        return;
      }
      if (!postbackAccepted(peekPaneSpawnSpec(paneId), token)) {
        log.warn(
          "web:bridge",
          `${label} for ${paneId} with a wrong token — ignored`,
        );
        return;
      }
      if (requireLiveProcess) {
        const session = paneSessionState(paneId).kind;
        if (session !== "live" && session !== "starting") {
          log.warn(
            "web:bridge",
            `${label} for ${paneId} with no live process (${session}) — ignored`,
          );
          return;
        }
      }
      apply(paneId, payload);
    })
    .then((unsubscribe) => {
      if (disposed) unsubscribe();
      else unlisten = unsubscribe;
    })
    .catch((error) => {
      if (!disposed) {
        log.warn("web:bridge", `${label} listener failed: ${error}`);
      }
    });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      unlisten?.();
    },
  };
}
