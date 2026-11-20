/**
 * Who a team act takes — and every member it leaves, with why.
 *
 * A team's Suspend and Resume are not new rules about panes: each member is
 * judged by the very decision a single Suspend or Resume asks of it
 * (`paneSuspendRefusal`, `paneResumeBlock`), so a team act can never
 * disagree with a single one about any pane. What is the team's own is only
 * the cohort: which members, and the reasons the rest are left out — the
 * reasons the menu's refusal is made from.
 */
import {
  idleReadsAsStopped,
  paneResumeBlock,
  paneSuspendRefusal,
  remoteEndpointOf,
  type Pane,
  type PaneResumeBlock,
  type PaneSuspendRefusal,
} from "../panes";
import type { TeamGates } from "../../lifecycle";
import type { Workspace } from "../workspaces";
import { membersOf } from "./collection";

/** A team act's verdict on the team's members, in member order. */
export interface TeamCohort<Skip> {
  /** The members the act takes. */
  take: string[];
  /** Why it leaves each of the others — what its refusal is made from. */
  skip: Skip[];
}

/** Both acts' verdicts on one team at once — what its menu offers, and
 * so what its doors will take — beside what the machine says the team's
 * own actions would meet (null before it has said). */
export interface TeamActs {
  suspend: TeamCohort<TeamSuspendSkip>;
  resume: TeamCohort<TeamResumeSkip>;
  gates: TeamGates | null;
}

/** What the act cannot know from the deck alone: the sweep's verdict that a
 * pane's directory is gone, whether a plugin provides an agent, whether
 * a suspend is still reaping a pane's process, and the machine's gates. */
export interface TeamActFacts {
  blocked(paneId: string): boolean;
  agentAvailable(agentType: string): boolean;
  suspending(paneId: string): boolean;
  gates(teamId: string): TeamGates | null;
}

/** Why a team's Suspend leaves a member: exactly a single Suspend's
 * refusal of it. */
export type TeamSuspendSkip = PaneSuspendRefusal;

/** Why a team's Resume leaves a member down or alone: a single Resume's own
 * refusal, or one of the team's — it is already on its way up, it runs on
 * a server, or its folder is gone (its card's "Look again" is the way back). */
export type TeamResumeSkip = PaneResumeBlock | "waking" | "remote" | "blocked";

/** The team's members, each taken or left by `why` — null takes it. */
function cohort<Skip>(
  ws: Workspace,
  teamId: string,
  why: (pane: Pane) => Skip | null,
): TeamCohort<Skip> {
  const result: TeamCohort<Skip> = { take: [], skip: [] };
  for (const pane of membersOf(ws, teamId)) {
    const reason = why(pane);
    if (reason === null) result.take.push(pane.id);
    else result.skip.push(reason);
  }
  return result;
}

/** Who a team's Suspend takes: every member a single Suspend would. */
export function teamSuspendCohort(
  ws: Workspace,
  teamId: string,
  facts: Pick<TeamActFacts, "blocked" | "suspending">,
): TeamCohort<TeamSuspendSkip> {
  return cohort(ws, teamId, (pane) =>
    paneSuspendRefusal(ws, pane, { blocked: facts.blocked(pane.id), suspending: facts.suspending(pane.id) }),
  );
}

/** Whom an act asked about `named` members takes now: those of them it
 * would still take — never one it was not asked about. What a confirm
 * counts and what its door then acts on, so the two cannot differ. */
export function stillTaken(cohort: Pick<TeamCohort<unknown>, "take">, named: readonly string[]): string[] {
  return cohort.take.filter((paneId) => named.includes(paneId));
}

/** Who a team's Resume takes: every member down by a decision — parked at
 * launch or suspended — that a single Resume would ask back, that runs here
 * and whose folder is still there. */
export function teamResumeCohort(
  ws: Workspace,
  teamId: string,
  facts: TeamActFacts,
): TeamCohort<TeamResumeSkip> {
  return cohort<TeamResumeSkip>(ws, teamId, (pane) => {
    const block = paneResumeBlock(ws, pane, facts.agentAvailable(pane.agentType));
    if (block) return block;
    // The folder first: the sweep leaves a pane it found on a gone folder
    // marked as rising, and reading the marker alone would call it on its
    // way up when it is going nowhere.
    if (facts.blocked(pane.id)) return "blocked";
    if (!idleReadsAsStopped(pane.idle, false)) return "waking";
    return remoteEndpointOf(pane) !== null ? "remote" : null;
  });
}

/** Both of a team's acts at once — what its menu offers. */
export function teamActsOf(ws: Workspace, teamId: string, facts: TeamActFacts): TeamActs {
  return {
    suspend: teamSuspendCohort(ws, teamId, facts),
    resume: teamResumeCohort(ws, teamId, facts),
    gates: facts.gates(teamId),
  };
}
