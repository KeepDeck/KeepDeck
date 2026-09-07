/**
 * What closing will actually do, in the dialog's own words — the copy, and
 * nothing else.
 *
 * Kept apart from the flow that shows it because the sentence has its own
 * history of being wrong (see [`closeMessageFor`]) and its own reason to
 * change; here it is addressable without a workspace, a probe and a render.
 */
import type { CarrierNote, ClosingTarget } from "./closingTarget";

/** The sentence about the sessions a close of `count` agents ends, of
 * which `running` still hold one. Only the agents that actually HOLD a
 * session are counted as losing one. "Stopped" is not the word for all of
 * the rest — a pane on its way up has no session YET, and one mid-create
 * has never had one — so the none-running case says what is true of every
 * way of having none, rather than branching on a distinction this sentence
 * does not need. */
function sessionsEnded(count: number, running: number, removes: string): string {
  if (running === 0) {
    return count === 1
      ? `This ends no session; ${removes} removes 1 agent.`
      : `This ends no sessions; ${removes} removes ${count} agents.`;
  }
  return running === 1
    ? "This ends 1 agent and its session."
    : `This ends ${running} agents and their sessions.`;
}

/**
 * What closing will actually do, in the dialog's own words.
 *
 * A pure function rather than a hook-body expression: the sentence has been
 * wrong three times — it promised to delete a worktree the default path
 * keeps, to end sessions of agents that were already stopped, and to end one
 * a pane had never opened — and every correction was verified only by driving
 * the whole hook. Here the table is addressable on its own, so a case can be
 * pinned without a workspace, a probe and a render.
 */
export function closeMessageFor(
  closing: ClosingTarget | null,
  /** For a team or workspace close: how many of its agents still hold a
   * session. The only fact this cannot take from the snapshot, because
   * such a close is about panes it does not name individually. */
  runningAgents: number,
  /** The late-arriving carrier line, painted when the registry answers —
   * null until then (and forever, on an ordinary "none"). */
  carrier: CarrierNote | null = null,
): string {
  if (!closing) return "";
  // The carrier note's text, per branch: one conversation vs at least one.
  // An unreachable registry warns too — skipping the warning on a failed
  // question returns the harm whole.
  const note =
    carrier === null
      ? ""
      : carrier.kind === "background"
        ? closing.kind === "agent"
          ? "\nIts conversation is carried by a background agent — closing removes the pane, not the work. To stop the work, use the CLI's own agents screen."
          : "\nAt least one conversation is carried by a background agent — closing removes the panes, not the work. To stop it, use the CLI's own agents screen."
        : closing.kind === "agent"
          ? "\nIts conversation may still be carried by a background agent (the live registry could not be reached) — closing removes the pane, not any work in progress."
          : "\nAt least one conversation may still be carried by a background agent (the live registry could not be reached) — closing removes the panes, not any work in progress.";
  if (closing.kind === "workspace") {
    if (closing.count === 0) return "This workspace has no agents." + note;
    return sessionsEnded(closing.count, runningAgents, "closing") + note;
  }
  if (closing.kind === "team") {
    if (closing.count === 0) {
      return "This team has no agents; disbanding removes the team." + note;
    }
    return (
      sessionsEnded(closing.count, runningAgents, "disbanding") +
      " The team is removed." +
      note
    );
  }
  const facts = closing.pane;
  // The last member's dialog says what each verb does to the team — once,
  // ahead of the pane's own sentence, whatever state the pane is in.
  const verbs = closing.last
    ? `It is the last agent on “${closing.last.name}”. Disbanding removes the team as well; closing the agent alone keeps the team and its directory.\n`
    : "";
  // Never ran: no session to end, and nothing to suspend.
  if (facts.provisioning) return verbs + "Its worktree is still being created.";
  // A stopped pane has no session to end, and saying so would contradict the
  // card the user is looking at. Whether the worktree survives is the
  // checkbox's business, not this sentence's.
  if (facts.stopped) return verbs + "It is stopped; closing removes the pane." + note;
  // Mutually exclusive with the branch above by construction: a stopped pane
  // is exactly the one `paneSuspendBlock` refuses.
  const alternative = facts.canSuspend
    ? closing.last && closing.last.targets.length > 0
      ? "\nSuspending stops the agent instead, keeping the pane, its worktree and its session."
      : "\nSuspending stops the agent instead, keeping the pane and its session."
    : "";
  // A pane on its way up has no session YET — promising to end one, while the
  // line below offers to keep "its session", described a pane that does not
  // exist in either direction.
  const opening = facts.rising
    ? "It is starting up; closing removes the pane."
    : "Its terminal session will be ended.";
  return verbs + opening + alternative + note;
}

/**
 * Owns the confirmed-close flow: all three close paths ([U6]) park a
 * ClosingTarget for the confirm dialog — once its candidate worktrees are
 * probed, so a directory that's already gone is never offered for deletion;
 * confirming removes the pane(s) from the deck AND ends their PTY sessions
 * through the ptyManager (unmounting alone no longer kills a process), then
 * optionally tears the worktrees down per the delete checkbox — after the
 * closes settle, so no worktree dir is a live cwd.
 *
 * A directory is a TEAM's: closing one agent is never asked about one, and
 * only a disband (or a workspace close, which disbands every team) carries
 * the offer. The last member of a team is the one pane whose close dialog
 * speaks both verbs.
 */
