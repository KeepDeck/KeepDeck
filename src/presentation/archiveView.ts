/**
 * What the archive confirm says — decided apart from the dialog that paints
 * it. The person sees, before anything stops: how many agents stop and how
 * many are already suspended (and stay so), what happens to a remote one,
 * that nothing of the workspace is deleted, and where to find it again.
 *
 * The counts are the archive's own rule ([`paneArchiveFate`]), not a
 * reading of what is running: an archive stops every local agent, a parked
 * or never-started one too, so "stops" counts them all.
 */
import { paneArchiveFate, type ArchiveOutcome, type Workspace } from "../domain/deck";

export interface ArchiveConfirmView {
  title: string;
  /** Paragraphs, `\n\n` between them — the dialog's line breaks. */
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function agentsSentence(stopping: number, suspended: number, detached: number): string {
  const parts: string[] = [];
  if (stopping > 0) {
    parts.push(
      `${stopping} ${plural(stopping, "agent stops", "agents stop")}` +
        (suspended > 0 ? `; ${suspended} already suspended ${plural(suspended, "stays", "stay")} so.` : "."),
    );
  } else if (suspended > 0) {
    parts.push("Its agents are already suspended.");
  } else if (detached === 0) {
    parts.push("It has no agents.");
  }
  if (detached > 0) {
    parts.push(
      `${detached} remote ${plural(detached, "agent keeps", "agents keep")} running on ${plural(detached, "its", "their")} server; only the connection here closes.`,
    );
  }
  return parts.join(" ");
}

export function archiveConfirmView(ws: Workspace): ArchiveConfirmView {
  let stopping = 0;
  let suspended = 0;
  let detached = 0;
  for (const pane of ws.panes) {
    const fate = paneArchiveFate(ws, pane);
    if (fate === "stopped") stopping++;
    else if (fate === "already-suspended") suspended++;
    else if (fate === "detached") detached++;
  }
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
 * archive done, or one already done elsewhere, needs no word. */
export function archiveRefusalText(outcome: ArchiveOutcome, name: string): string | null {
  switch (outcome) {
    case "closing":
      return `“${name}” is being closed, so it cannot be archived.`;
    case "gone":
      return `“${name}” is no longer open.`;
    case "archived":
    case "already":
      return null;
  }
}
