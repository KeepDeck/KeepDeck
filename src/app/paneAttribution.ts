import {
  bindingVerdict,
  secretMatches,
  speaksForPane,
  type BindingOrigin,
  type BindingVerdict,
} from "../domain/agents";
import {
  findWorkspaceOfPane,
  paneAgentType,
  type Workspace,
} from "../domain/deck";
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
  /** This pane's generation now has an identity, reported by this process:
   * a later fresh session, or any session from another process, is somebody
   * else's. */
  recordBinding(paneId: string, reporter: string | undefined): void;
  /** The pane's process is retiring — the next fresh session it reports is
   * legitimately its own again. */
  retire(paneId: string): void;
  /** Keep only panes the deck still holds. The other holders of per-pane
   * state are swept this way too; without it this ledger is the one map that
   * only ever grows. */
  forget(live: ReadonlySet<string>): void;
}

/**
 * The words our agents actually report for a continued conversation, and the
 * one place they are translated into the deck's two.
 *
 * This lives HERE, not in the domain rule, because it is per-vendor protocol
 * vocabulary: it changes when a CLI changes, while the rule it feeds changes
 * when the deck's idea of identity does. Today the four agents agree — claude
 * defined the words, codex and kimi copied its hooks design, opencode's
 * reporter says `new` for its one mid-life case — so one set is the whole
 * translation. The moment two of them disagree, this is the seam that becomes
 * a per-agent contribution beside `usage.normalize` and `status.normalize`.
 */
const SWAP_WORDS: ReadonlySet<string> = new Set([
  "resume",
  "clear",
  "compact",
  "fork",
  "new",
]);

/**
 * The CLI's own word for why a session started, read as one bit.
 *
 * Anything unrecognised — a word from a newer CLI, a field the reporter could
 * not fill, a reporter too old to send one — reads as `startup`, the STRICT
 * side: an unrecognised binding can then only be refused as a second start,
 * never accepted as a continuation. Guessing the other way would hand every
 * unknown word the one verdict that overwrites the pane's identity.
 */
export function bindingOrigin(source: string | undefined): BindingOrigin {
  return source !== undefined && SWAP_WORDS.has(source) ? "swap" : "startup";
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
  /** paneId → the process that bound this generation (undefined when that
   * reporter could not name itself). Presence IS "this generation bound". */
  const bound = new Map<string, string | undefined>();

  // Through the catalog's accessor, never the raw field: a pane with no
  // recorded type RUNS the default agent and arms its reporter under that
  // name, so reading the field raw would refuse every report the pane makes.
  const agentOf = (paneId: string): string | undefined => {
    const pane = findWorkspaceOfPane(deps.workspaces(), paneId)?.panes.find(
      (candidate) => candidate.id === paneId,
    );
    return pane ? paneAgentType(pane) : undefined;
  };

  return {
    judge(report) {
      return bindingVerdict({
        paneSecret: deps.secretOf(report.paneId),
        reportedSecret: report.token,
        paneAgent: agentOf(report.paneId),
        reportedAgent: report.agent,
        origin: bindingOrigin(report.source),
        boundThisGeneration: bound.has(report.paneId),
        boundReporter: bound.get(report.paneId),
        reportedReporter: report.reporter,
      });
    },
    admitsReport(paneId, reportedSecret, reportedAgent) {
      return (
        secretMatches(deps.secretOf(paneId), reportedSecret) &&
        speaksForPane(agentOf(paneId), reportedAgent)
      );
    },
    recordBinding(paneId, reporter) {
      // The FIRST binding of a generation pins it, and nothing after that
      // moves the pin. Re-pinning on every accepted report looks harmless
      // until one of them cannot name its process: that report would erase
      // the pin, the next one — a nested run, say — would set it to ITS
      // process, and the pane's own agent would then be refused as foreign
      // for the rest of the generation. A pin that only `retire` clears
      // cannot be walked away from one silent report at a time.
      if (!bound.has(paneId)) bound.set(paneId, reporter);
    },
    retire(paneId) {
      bound.delete(paneId);
    },
    forget(live) {
      for (const paneId of [...bound.keys()]) {
        if (!live.has(paneId)) bound.delete(paneId);
      }
    },
  };
}
