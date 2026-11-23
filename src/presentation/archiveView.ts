/**
 * What the archive confirm says — decided apart from the dialog that paints
 * it. The person sees, before anything stops: how many agents stop and how
 * many are already suspended (and stay so), what happens to a remote one,
 * that nothing of the workspace is deleted, and where to find it again.
 *
 * How many agents stop is the lifecycle machine's to say — its preview of
 * the archive names them, every local agent a parked or never-started one
 * too — not a reading of what is running. The ones already suspended and the
 * remote ones are the panes' own facts.
 */
import { remoteEndpointOf, type Workspace } from "../domain/deck";
import type { IntentOutcome } from "../domain/lifecycle";
import { intentOutcomeText } from "./lifecycleWords";
import { byCount } from "./countWords";

export interface ArchiveConfirmView {
  title: string;
  /** Paragraphs, `\n\n` between them — the dialog's line breaks. */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

function agentsSentence(stopping: number, suspended: number, detached: number): string {
  const parts: string[] = [];
  if (stopping > 0) {
    parts.push(
      `${stopping} ${byCount(stopping, "agent stops", "agents stop")}` +
        (suspended > 0 ? `; ${suspended} already suspended ${byCount(suspended, "stays", "stay")} so.` : "."),
    );
  } else if (suspended > 0) {
    parts.push("Its agents are already suspended.");
  } else if (detached === 0) {
    parts.push("It has no agents.");
  }
  if (detached > 0) {
    parts.push(
      `${detached} remote ${byCount(detached, "agent keeps", "agents keep")} running on ${byCount(detached, "its", "their")} server; only the connection here closes.`,
    );
  }
  return parts.join(" ");
}

/** The confirm for archiving `ws`, which stops `stopping` agents. */
export function archiveConfirmView(ws: Workspace, stopping: number): ArchiveConfirmView {
  const suspended = ws.panes.filter((pane) => pane.idle?.reason === "suspended").length;
  const detached = ws.panes.filter((pane) => remoteEndpointOf(pane) !== null).length;
  return {
    title: `Archive “${ws.name}”?`,
    message: [
      `${agentsSentence(stopping, suspended, detached)} Restore brings the workspace back with its agents still stopped; each conversation resumes where it stopped when you resume it, if its agent can.`,
      "Teams, worktrees and branches, the board, artifacts, MCP servers and session history are kept — nothing of the workspace is deleted.",
      "It leaves the strip. Find it under Archived, and restore it any time.",
    ].join("\n\n"),
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
  };
}

/** What a refused archive says, or null when there is nothing to say: an
 * archive the machine took on, or one already done elsewhere, needs no
 * word. A refusal of its own the archive says of the workspace by name;
 * any other, in the machine's words. */
export function archiveRefusalText(outcome: IntentOutcome, name: string): string | null {
  if (outcome.kind !== "refused") return intentOutcomeText(outcome);
  switch (outcome.refusal.kind) {
    case "archived":
      return null;
    case "alreadyClosing":
    case "targetLeaving":
      return `“${name}” is being closed, so it cannot be archived.`;
    case "notFound":
      return `“${name}” is no longer open.`;
    default:
      return intentOutcomeText(outcome);
  }
}
