/**
 * What "another team already works here" is called, in the two places it has
 * to be said: the question a person answers, and the refusal an agent reads.
 *
 * One module because it is ONE fact with two audiences — who is there, and
 * that both teams would then run on the same files and the same branch. The
 * halves that genuinely differ are the ask (what the buttons will do) and the
 * agent's way out (the flag to pass), and they differ here, in one place, so
 * a change to the rule cannot reach one audience and not the other. Written
 * as pure functions for the reason [`closeMessageFor`] is: this sentence
 * makes a promise about what a later close will do, and a promise assembled
 * inside a view can only be checked by rendering the view.
 */
import type { DirectoryHolder } from "./agentOrchestrator";

/** Who is in the directory, said once. */
function holderPhrase(holder: DirectoryHolder): string {
  return holder.workspace
    ? `team “${holder.teamName}” (${holder.teamId}) in workspace “${holder.workspace}”`
    : `team “${holder.teamName}” (${holder.teamId})`;
}

/** The question a person answers before a second team is born in a directory
 * somebody already works in. */
export function sharedDirectoryAsk(
  holder: DirectoryHolder,
  directory: string,
): { title: string; message: string } {
  return {
    title: "That directory is already a team's",
    message:
      `${holder.teamName}${holder.workspace ? ` (workspace “${holder.workspace}”)` : ""}` +
      ` already works in ${directory}.\n\n` +
      "Both teams would run in the same directory — their agents share the " +
      "same files and the same branch. Neither team's worktree is deleted " +
      "while the other still works there.",
  };
}

/**
 * The same refusal for an agent, which has no dialog to answer: it names the
 * holder and the way to mean it.
 *
 * The advice differs by WHERE the holder is, and must: `team.add` resolves a
 * team inside the calling workspace only, so pointing an agent at a team in
 * another workspace would send it to an error. Saying both cases in one
 * sentence is exactly how that happened.
 */
export function sharedDirectoryRefusal(holder: DirectoryHolder): string {
  const join = holder.workspace
    ? "no team.add here can reach it"
    : "team.add puts an agent on it";
  return (
    `that directory is already ${holderPhrase(holder)} — ${join}, ` +
    "or pass shared: true for a second team in the same directory"
  );
}
