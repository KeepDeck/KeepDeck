import type { BridgeReport } from "../ipc/bridgeReport";
import { log } from "../ipc/log";
import type { PaneAttribution } from "./paneAttribution";
import type { PaneSessionState } from "./ptyManager";
import { isJsonRecord } from "@keepdeck/plugin-api";

/** The state a pane's process is in, as the sessions owner says it. */
export type ProcessOf = (paneId: string) => PaneSessionState["kind"];

/** What a verified report's lane is told beside its payload. */
export interface ReportContext {
  /** The process that sent it, as the bridge named it; absent when none. */
  reporter: string | undefined;
  /** Whether the pane's process is still up, asked again by the lane's own
   * rule — what a lane that waits before it lands asks once it is done
   * waiting. Always true on a lane that requires no process. */
  stillUp(): boolean;
}

export interface VerifiedPaneReportsOptions {
  /** The log noun ("usage report", "status report") — rejections must say
   * which lane dropped what. */
  label: string;
  /** Subscribe to the lane's ipc event; resolves to the unlisten. */
  subscribe: (
    handler: (report: BridgeReport) => void,
  ) => Promise<() => void>;
  /** Require the pane's PROCESS to be up, as this source says (spawning
   * counts — a hook can beat the spawn promise's resolution by
   * milliseconds). Activity is a claim about a live process, so its lane
   * requires this; usage describes the session and account, which outlive
   * the process, so its lane does not — a tail's final token_count after a
   * crash is still true. */
  processOf?: ProcessOf;
  /** Apply one verified report. */
  apply: (paneId: string, payload: unknown, context: ReportContext) => void;
}

export interface VerifiedPaneReports {
  dispose(): void;
}

/** A process that is up: live, or still starting. */
const isUp = (kind: PaneSessionState["kind"]) => kind === "live" || kind === "starting";

/**
 * The one home of "who may report for a pane" — the session-binding rule
 * applied to a report lane: the pane must hold a plan that reports AND the
 * report come from the agent the pane runs (a pane the deck no longer holds
 * runs none), and (per lane) the process must be alive. Every bridge lane
 * verifies HERE; a guard growing a condition in one lane but not another is
 * exactly how a retired generation would keep reporting through the weaker
 * one.
 *
 * Where a report comes from the bridge's door has already judged — the
 * pane's terminal and its bridge secret. The agent half is left to here: a
 * nested CLI's statusline runs in that same terminal — and, dispatched by
 * the agent it names, would rewrite the pane's usage and activity with a
 * foreign session's numbers. That is a second, independent route to the
 * wrong reading the binding rule exists to prevent, and it needs no
 * rebinding at all.
 */
export function createVerifiedPaneReports(
  attribution: PaneAttribution,
  options: VerifiedPaneReportsOptions,
): VerifiedPaneReports {
  const { label, processOf, apply } = options;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void options
    .subscribe(({ paneId, reporter, payload }) => {
      if (disposed) return;
      // `agent` is part of the opaque envelope's correlation contract — the
      // bridge refuses a report without one — so reading it here is not this
      // file learning a payload schema it has no business knowing.
      const reportedAgent =
        isJsonRecord(payload) && typeof payload.agent === "string"
          ? payload.agent
          : undefined;
      // The process comes as the bridge's door checked it: a reporter that
      // named none is unnamed here too, and the pane's pin then decides
      // nothing rather than refusing everything.
      if (!attribution.admitsReport(paneId, reportedAgent, reporter)) {
        log.warn(
          "web:bridge",
          `${label} for ${paneId} from ${reportedAgent ?? "an unnamed agent"} — ignored`,
        );
        return;
      }
      const kind = processOf?.(paneId);
      if (kind !== undefined && !isUp(kind)) {
        log.warn(
          "web:bridge",
          `${label} for ${paneId} with no live process (${kind}) — ignored`,
        );
        return;
      }
      apply(paneId, payload, {
        reporter,
        stillUp: () => processOf === undefined || isUp(processOf(paneId)),
      });
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
