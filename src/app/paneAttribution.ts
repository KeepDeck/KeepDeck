import {
  bindingVerdict,
  sameProcess,
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
import { log } from "../ipc/log";
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
    reportedReporter: string | undefined,
  ): boolean;
  /** This pane's generation now has an identity, reported by this process:
   * a later FRESH session — a second one here, or one from another process —
   * is somebody else's. A continuation may move the pin, because the pane's
   * own agent may have moved. */
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
    admitsReport(paneId, reportedSecret, reportedAgent, reportedReporter) {
      return (
        secretMatches(deps.secretOf(paneId), reportedSecret) &&
        speaksForPane(agentOf(paneId), reportedAgent) &&
        // The same pin the binding uses: a nested run refused an identity is
        // still holding a valid secret, and its statusline would otherwise
        // write this pane's usage and context with another session's numbers.
        //
        // And the one place the two lanes are deliberately NOT symmetrical: a
        // report carries no origin word, so this side cannot make the
        // continuation exemption the binding rule makes. It follows the pin
        // instead, which the binding lane moves when the agent re-hosts. Give
        // this side the exemption too and every report becomes unplaceable;
        // take it from the binding lane and the pane freezes where it stood.
        sameProcess(bound.get(paneId), reportedReporter)
      );
    },
    recordBinding(paneId, reporter) {
      // The first binding of a generation establishes the entry — its presence
      // is what "this generation has bound" means, named process or not.
      if (!bound.has(paneId)) {
        bound.set(paneId, reporter);
        return;
      }
      // After that the pin MOVES only between two named processes. An accepted
      // binding has passed the whole rule, so the only one that can come from
      // another process is a continuation — the pane's own agent re-hosting
      // its conversation (claude's daemon fork). Following it is the point:
      // every later report comes from there, and both lanes read this pin.
      //
      // The two silences stay exactly as they were. A binding that cannot name
      // its process must not erase a pin: that erasure was enough to walk the
      // pin away one report at a time, letting the next one — a nested run,
      // say — claim it and leave the pane's own agent foreign for the rest of
      // the generation. And a generation that started blind stays blind,
      // because nothing distinguishes "could not name itself, then could" from
      // "could not, and something else answered instead" — adopting there
      // would lock the pane out on a process it cannot vouch for.
      const pinned = bound.get(paneId);
      if (reporter !== undefined && pinned !== undefined) {
        // Said out loud, because the silence this repairs was diagnosable only
        // by reading a log next to a process tree: a pane whose reports are
        // being refused shows a `foreign-process` line per report and nothing
        // that says WHEN its agent moved. Only an actual move is logged — a
        // rebind by the same process is the ordinary case and would drown it.
        if (pinned !== reporter) {
          log.info(
            "web:bridge",
            `${paneId}: reporting process moved ${pinned} → ${reporter}`,
          );
        }
        bound.set(paneId, reporter);
      }
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
