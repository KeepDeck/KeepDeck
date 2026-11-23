/**
 * Who a team act takes — and every member it leaves, with why.
 *
 * A team's Suspend and Resume are not new rules about panes: each member is
 * judged by the very decision a single Suspend or Resume asks of it
 * (`paneSuspendRefusal`, `paneResumeBlock`), so a team act can never
 * disagree with a single one about any pane. What is the team's own is only
 * the cohort: which members, and the reasons the rest are left out — the
 * reasons the menu's refusal is made from — and that a team act waits for
 * the whole team: while any member is still on its way up or down, neither
 * act takes anybody.
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
import type { AgentReach } from "../runIntent";
import type { TeamGates } from "../../lifecycle";
import type { Workspace } from "../workspaces";
import { findTeam, membersOf } from "./collection";

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
 * a suspend is still reaping a pane's process, where each agent stands —
 * running, on its way up, or down and why — and the machine's gates. */
export interface TeamActFacts {
  blocked(paneId: string): boolean;
  agentAvailable(agentType: string): boolean;
  suspending(paneId: string): boolean;
  /** Where the pane's agent stands; null for a pane nothing is known of. */
  reach(paneId: string): AgentReach | null;
  gates(teamId: string): TeamGates | null;
}

/** A member a team act leaves because the team is not settled yet: some
 * member of it is still on its way up or down. */
type Settling = "settling";

/** Why a team's Suspend leaves a member: a single Suspend's refusal of it,
 * or that its team is not settled yet. */
export type TeamSuspendSkip = PaneSuspendRefusal | Settling;

/** Why a team's Resume leaves a member down or alone: a single Resume's own
 * refusal, or one of the team's — it is already on its way up, it runs on
 * a server, its folder is gone (its card's "Look again" is the way back), or
 * its team is not settled yet. */
export type TeamResumeSkip = PaneResumeBlock | "waking" | "remote" | "blocked" | Settling;

/** Whether an agent is between two states: on its way up by itself — a
 * process starting, a restart — or being suspended or taken down. Down for
 * any other reason is a state, not a way to one. */
function between(reach: AgentReach | null): boolean {
  if (reach === null) return false;
  return reach.kind === "starting" || (reach.kind === "down" && (reach.why === "suspending" || reach.why === "leaving"));
}

/** Whether a team act has to wait: some member is still on its way up or
 * down, and an act on the team now would meet it half-way — a Resume
 * refused for an agent whose stop has not ended, a Suspend that stops what
 * is still starting. A team still creating its worktree does not wait:
 * nothing of it is running, and both acts already refuse it in its own
 * words. */
function unsettled(ws: Workspace, teamId: string, facts: Pick<TeamActFacts, "reach">): boolean {
  if (findTeam(ws, teamId)?.location?.kind === "provisioning") return false;
  return membersOf(ws, teamId).some((pane) => between(facts.reach(pane.id)));
}

/** The team's members, each taken or left by `why` — null takes it — or,
 * while the team is not settled, every one of them left to wait for it. */
function cohort<Skip>(
  ws: Workspace,
  teamId: string,
  facts: Pick<TeamActFacts, "reach">,
  why: (pane: Pane) => Skip | null,
): TeamCohort<Skip | Settling> {
  const waits = unsettled(ws, teamId, facts);
  const result: TeamCohort<Skip | Settling> = { take: [], skip: [] };
  for (const pane of membersOf(ws, teamId)) {
    const reason = waits ? "settling" : why(pane);
    if (reason === null) result.take.push(pane.id);
    else result.skip.push(reason);
  }
  return result;
}

/** Who a team's Suspend takes: every member a single Suspend would, once
 * the team is settled. */
export function teamSuspendCohort(
  ws: Workspace,
  teamId: string,
  facts: Pick<TeamActFacts, "blocked" | "suspending" | "reach">,
): TeamCohort<TeamSuspendSkip> {
  return cohort(ws, teamId, facts, (pane) =>
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
 * and whose folder is still there, once the team is settled. */
export function teamResumeCohort(
  ws: Workspace,
  teamId: string,
  facts: TeamActFacts,
): TeamCohort<TeamResumeSkip> {
  return cohort<Exclude<TeamResumeSkip, Settling>>(ws, teamId, facts, (pane) => {
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
