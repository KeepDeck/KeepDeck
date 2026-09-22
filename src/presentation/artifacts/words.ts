import type { ArtifactsView } from "./view";

/**
 * The artifacts dialog's words for its states — one home, so the dialog
 * only places them.
 */

/** What the body says when it has no rows to show. */
export interface PlaceholderWords {
  /** The headline; null when the state is a single quiet line. */
  title: string | null;
  detail: string | null;
  /** The title is the store's refusal: announced, and selectable so it
   * can be copied into a report. */
  alert: boolean;
}

export function placeholderWords(
  view: Exclude<ArtifactsView, { kind: "rows" }>,
): PlaceholderWords {
  switch (view.kind) {
    case "noWorkspace":
      return {
        title: "No workspace open",
        detail: "Artifacts belong to a workspace — open one first",
        alert: false,
      };
    case "loading":
      return { title: null, detail: "Loading…", alert: false };
    case "refusal":
      return { title: view.message, detail: null, alert: true };
    case "noMatch":
      return {
        title: `Nothing matches “${view.query}”`,
        detail: "This workspace has artifacts; none of them by that name",
        alert: false,
      };
    case "empty":
      return {
        title: "Nothing published yet",
        detail:
          "Agents publish pages here; they open in your browser and refresh themselves as the agent iterates",
        alert: false,
      };
  }
}

/** Under an open row whose versions are still being read. */
export const HISTORY_LOADING = "Loading…";

/** Under an open row whose read came back empty. */
export const HISTORY_GONE = "No versions — the artifact went while this opened";

/** The delete confirm's question: what goes, said before it goes. */
export function deleteQuestion(title: string): string {
  return `Delete "${title}"? Every version goes, its open pages say goodbye, and the id stops resolving`;
}
