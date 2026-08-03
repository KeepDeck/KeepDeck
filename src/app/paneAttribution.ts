import {
  bindingOrigin,
  bindingVerdict,
  secretMatches,
  speaksForPane,
  type BindingVerdict,
} from "../domain/agents";
import { findWorkspaceOfPane, type Workspace } from "../domain/deck";
import type { SessionBound } from "../ipc/sessions";

/**
 * The one owner of "may this report speak for that pane?".
 *
 * Every lane the bridge carries — identity, usage, status — is correlated by
 * pane and authenticated by a secret the pane's whole process tree inherits,
 * so every lane has the same question to answer and it must be answered the
 * same way. Asking it in three handlers is how the answers drift; the rule
 * itself lives in the domain ([`bindingVerdict`]) and this holds the only
 * state that rule needs but cannot see: whether the pane's CURRENT process
 * generation has already bound a session.
 *
 * That state is retired through the same lifecycle call the pane's telemetry
 * already uses, so a restart, suspend, close or exit resets it without any
 * call site learning a second thing to do.
 */
export interface PaneAttribution {
  /** Judge one session binding — the full rule, with a reason when refused. */
  judge(bound: SessionBound): BindingVerdict;
  /** Whether a pane-correlated report may be applied to `paneId`: the secret
   * is the pane's and the reporter is the agent the pane runs. For the lanes
   * that carry no session identity of their own, where there is no fresh-vs-
   * continuing distinction to make. */
  admitsReport(
    paneId: string,
    reportedSecret: string,
    reportedAgent: string | undefined,
  ): boolean;
  /** This pane's generation now has an identity: a later fresh session is
   * somebody else's. */
  recordBinding(paneId: string): void;
  /** The pane's process is retiring — the next fresh session it reports is
   * legitimately its own again. */
  retire(paneId: string): void;
}

export interface PaneAttributionDeps {
  /** The deck as it is NOW: a pane's agent is read per call, because the
   * pane may have been closed or replaced since the report was written. */
  workspaces(): Workspace[];
  /** The bridge secret this pane's own spawn plan carries, or undefined when
   * the pane armed no reporter. */
  secretOf(paneId: string): string | undefined;
}

export function createPaneAttribution(
  deps: PaneAttributionDeps,
): PaneAttribution {
  const bound = new Set<string>();

  const agentOf = (paneId: string): string | undefined =>
    findWorkspaceOfPane(deps.workspaces(), paneId)?.panes.find(
      (pane) => pane.id === paneId,
    )?.agentType;

  return {
    judge(report) {
      return bindingVerdict({
        paneSecret: deps.secretOf(report.paneId),
        reportedSecret: report.token,
        paneAgent: agentOf(report.paneId),
        reportedAgent: report.agent,
        origin: bindingOrigin(report.source),
        boundThisGeneration: bound.has(report.paneId),
      });
    },
    admitsReport(paneId, reportedSecret, reportedAgent) {
      return (
        secretMatches(deps.secretOf(paneId), reportedSecret) &&
        speaksForPane(agentOf(paneId), reportedAgent)
      );
    },
    recordBinding(paneId) {
      bound.add(paneId);
    },
    retire(paneId) {
      bound.delete(paneId);
    },
  };
}
