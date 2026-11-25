import {
  bindingVerdict,
  sameProcess,
  speaksForPane,
  type BindingOrigin,
  type BindingVerdict,
} from "../domain/agents";
import {
  findWorkspaceOfPane,
  type Workspace,
} from "../domain/deck";
import type { AgentBindingReport } from "@keepdeck/plugin-api";
import { log } from "../ipc/log";
import type { SessionBound } from "../ipc/sessions";

/**
 * The one owner of "may this report speak for that pane?".
 *
 * Every lane the bridge carries — identity, usage, status — is correlated by
 * pane, and the bridge's door has placed every report in the pane's
 * terminal, which the pane's whole process tree shares — so every lane has
 * the same question left to answer and it must be answered the same way.
 * Asking it in three handlers is how the answers drift; the rule
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
  /** Whether a pane-correlated report may be applied to `paneId`: the pane
   * holds a plan that reports and the reporter is the agent the pane runs. For
   * the lanes that carry no session identity of their own, where there is no
   * fresh-vs-continuing distinction to make. */
  admitsReport(
    paneId: string,
    reportedAgent: string | undefined,
    reportedReporter: string | undefined,
  ): boolean;
  /** This pane's generation now has an identity, reported by this process:
   * a later FRESH session — a second one here, or one from another process —
   * is somebody else's. A continuation may move the pin, because the pane's
   * own agent may have moved. */
  recordBinding(paneId: string, reporter: string | undefined): void;
  /** A companion — a reporter inside the agent process — said hello from
   * `reporter`. Recorded per pane and retired with the pane's process, like
   * the pin it is read against. */
  recordCompanion(paneId: string, reporter: string): void;
  /** Whether the process this pane is pinned to announced a companion. A
   * hello from a process the pane is not pinned to — the conversation moved
   * on, or never bound here — says nothing about the one that reports now. */
  hasCompanion(paneId: string): boolean;
  /** Told when a pane's `hasCompanion` answer may have changed by a hello or
   * a retirement. A pin that moves is announced by its binding, which every
   * reader of this already follows. */
  subscribeCompanions(listener: (paneId: string) => void): () => void;
  /** The pane's process is retiring — the next fresh session it reports is
   * legitimately its own again. */
  retire(paneId: string): void;
  /** Keep only panes the deck still holds. The other holders of per-pane
   * state are swept this way too; without it this ledger is the one map that
   * only ever grows. */
  forget(live: ReadonlySet<string>): void;
}

/**
 * The CLI's own word for why a session started, read as one bit, against
 * the words the pane's agent declares for a continued conversation
 * (`AgentBinding.swapSources`) — per-CLI protocol vocabulary, so the
 * agent's, never a set the host keeps for all of them.
 *
 * Anything unrecognised — a word from a newer CLI, a field the reporter could
 * not fill, a reporter too old to send one, an agent that declared none —
 * reads as `startup`, the STRICT side: an unrecognised binding can then only
 * be refused as a second start, never accepted as a continuation. Guessing
 * the other way would hand every unknown word the one verdict that
 * overwrites the pane's identity.
 */
export function bindingOrigin(
  source: string | undefined,
  swapSources: readonly string[],
): BindingOrigin {
  return source !== undefined && swapSources.includes(source) ? "swap" : "startup";
}

export interface PaneAttributionDeps {
  /** The deck as it is NOW: a pane's agent is read per call, because the
   * pane may have been closed or replaced since the report was written. */
  workspaces(): Workspace[];
  /** Whether the pane holds a plan that reports (`planReports`): none when
   * it armed no reporter, or once a teardown has retired its plan — before it
   * stops the process, which can still speak in between. */
  reports(paneId: string): boolean;
  /** The agent's own word on a fresh session from the pane's bound process
   * (`AgentContribution.binding`): its user's new conversation, or not.
   * Absent, or an agent with nothing to say, means not — the strict side. */
  restartsConversation?(agent: string, report: AgentBindingReport): boolean;
  /** The agent's words for a continued conversation
   * (`AgentBinding.swapSources`); none means every word is a fresh start. */
  swapSources(agent: string): readonly string[];
}

export function createPaneAttribution(
  deps: PaneAttributionDeps,
): PaneAttribution {
  /** paneId → the process that bound this generation (undefined when that
   * reporter could not name itself). Presence IS "this generation bound". */
  const bound = new Map<string, string | undefined>();
  /** paneId → the process whose companion said hello. */
  const companions = new Map<string, string>();
  const companionListeners = new Set<(paneId: string) => void>();
  const companionChanged = (paneId: string) => {
    for (const listener of [...companionListeners]) listener(paneId);
  };
  // Through the catalog's accessor, never the raw field: a pane with no
  // recorded type RUNS the default agent and arms its reporter under that
  // name, so reading the field raw would refuse every report the pane makes.
  const agentOf = (paneId: string): string | undefined => {
    const pane = findWorkspaceOfPane(deps.workspaces(), paneId)?.panes.find(
      (candidate) => candidate.id === paneId,
    );
    return pane ? pane.agentType : undefined;
  };

  /** The pane's agent on this report, asked safely: its contribution is a
   * plugin's code, and a throw there must cost the binding nothing but the
   * agent's word. Asked of the PANE's agent on every report; the verdict
   * heeds the answer only in its second-startup branch. */
  const restarts = (paneAgent: string | undefined, report: SessionBound): boolean => {
    if (!paneAgent || !deps.restartsConversation) return false;
    try {
      return deps.restartsConversation(paneAgent, {
        ...(report.source !== undefined ? { source: report.source } : {}),
        facts: report.facts ?? {},
      });
    } catch {
      return false;
    }
  };

  return {
    judge(report) {
      const paneAgent = agentOf(report.paneId);
      return bindingVerdict({
        paneReports: deps.reports(report.paneId),
        paneAgent,
        reportedAgent: report.agent,
        origin: bindingOrigin(report.source, paneAgent ? deps.swapSources(paneAgent) : []),
        boundThisGeneration: bound.has(report.paneId),
        boundReporter: bound.get(report.paneId),
        reportedReporter: report.reporter,
        restartsConversation: restarts(paneAgent, report),
      });
    },
    admitsReport(paneId, reportedAgent, reportedReporter) {
      return (
        deps.reports(paneId) &&
        speaksForPane(agentOf(paneId), reportedAgent) &&
        // The same pin the binding uses: a nested run refused an identity is
        // still in the pane's terminal, and its statusline would otherwise
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
      // another process is a continuation — the pane's own agent carrying its
      // conversation on in another process of the same terminal (the bridge's
      // door refuses a process a binding names outside that terminal, a
      // daemon's worker included). Following it is
      // the point: every later report comes from there, and both lanes read
      // this pin.
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
    recordCompanion(paneId, reporter) {
      if (companions.get(paneId) === reporter) return;
      companions.set(paneId, reporter);
      companionChanged(paneId);
    },
    hasCompanion(paneId) {
      const reporter = companions.get(paneId);
      return reporter !== undefined && reporter === bound.get(paneId);
    },
    subscribeCompanions(listener) {
      companionListeners.add(listener);
      return () => companionListeners.delete(listener);
    },
    retire(paneId) {
      bound.delete(paneId);
      if (companions.delete(paneId)) companionChanged(paneId);
    },
    forget(live) {
      for (const paneId of [...bound.keys()]) {
        if (!live.has(paneId)) bound.delete(paneId);
      }
      for (const paneId of [...companions.keys()]) {
        if (!live.has(paneId)) companions.delete(paneId);
      }
    },
  };
}
