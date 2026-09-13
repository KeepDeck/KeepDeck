import type { RepoTrouble } from "../domain/repoState";

/** The words for a failed read — what the tab, the History section and the
 * peek's rail print in place of a list. */
export function troubleText(trouble: RepoTrouble): string {
  switch (trouble.kind) {
    case "not-repo":
      return "Not a git repository.";
    case "no-git":
      return "git is not installed, or not on the PATH.";
    case "no-commits":
      return "No commits yet.";
    case "out-of-scope":
      return "Outside the workspace — nothing to read here.";
    case "failed":
      return trouble.detail;
  }
}
