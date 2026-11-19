/**
 * What a team's Suspend asks before it stops anyone — always, by the
 * person's decision, whatever its agents are doing. It says how many it
 * stops, whose work is at risk (one in the middle of a turn, one waiting
 * for an answer), and what each keeps.
 *
 * It promises a REQUEST, never an outcome: the deck asks each process to
 * end and cannot prove it did, for one agent or for a team.
 */
import type { Team } from "../domain/deck";
import type { PaneActivity } from "../domain/status";
import { byCount } from "./countWords";

export interface TeamSuspendConfirmView {
  title: string;
  /** Paragraphs, `\n\n` between them — the dialog's line breaks. */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** The members this confirm names — the only ones its Suspend may take. */
  shown: readonly string[];
}

function stopSentence(n: number, size: number): string {
  if (n < size) return `This requests a stop for ${n} of its ${size} agents.`;
  return byCount(n, "This requests a stop for its agent.", `This requests a stop for all ${n} agents.`);
}

/** Whose work a stop may cut short, or null when nobody's. */
function riskSentence(working: number, waiting: number): string | null {
  const who: string[] = [];
  const lost: string[] = [];
  if (working > 0) {
    who.push(`${working} ${byCount(working, "is", "are")} in the middle of a turn`);
    lost.push("that work");
  }
  if (waiting > 0) {
    who.push(`${waiting} ${byCount(waiting, "is", "are")} waiting for your answer`);
    lost.push(byCount(waiting, "that prompt", "those prompts"));
  }
  return who.length === 0 ? null : `${who.join(" and ")} — ${lost.join(" or ")} may be lost.`;
}

/** The confirm for stopping `shown` of a team of `size`, or null when it
 * would stop nobody. */
export function teamSuspendConfirmView(
  team: Pick<Team, "name">,
  size: number,
  shown: readonly string[],
  /** Live activity by pane — the tracker's snapshot. */
  activities: ReadonlyMap<string, PaneActivity>,
): TeamSuspendConfirmView | null {
  const n = shown.length;
  if (n === 0) return null;
  let working = 0;
  let waiting = 0;
  for (const paneId of shown) {
    const state = activities.get(paneId)?.state;
    if (state === "working") working++;
    else if (state === "waiting") waiting++;
  }
  const risk = riskSentence(working, waiting);
  return {
    title: `Suspend “${team.name}”?`,
    message: [
      risk ? `${stopSentence(n, size)} ${risk}` : stopSentence(n, size),
      `${byCount(n, "It keeps", "Each keeps")} its pane, its place on the team, the board and the worktree. Resume requests a start again; when its conversation is recorded, its agent is asked to reopen it where it can.`,
    ].join("\n\n"),
    // "Suspend all N", agreed with its count like every count on the deck:
    // one agent is not "all 1".
    confirmLabel: byCount(n, "Suspend", `Suspend all ${n}`),
    cancelLabel: "Cancel",
    shown,
  };
}
