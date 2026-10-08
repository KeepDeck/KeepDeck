/**
 * How the workspace form starts: on its own (the «+» on the strip) empty,
 * every field in view, leaving by Cancel; as the welcome screen's confirm
 * step with the folder already chosen — its name the folder's, leaving by
 * Back to the choice.
 */
import { baseName } from "../domain/deck";

export interface WorkspaceFormStart {
  name: string;
  cwd: string | null;
  /** The word on the way out, when there is one. */
  leave: "Back" | "Cancel";
  /** The folder is the one already chosen: shown, not picked again (Back
   * goes to choosing another). */
  folderFixed: boolean;
  className: string;
}

export function workspaceFormStart(chosenDir: string | null): WorkspaceFormStart {
  return chosenDir === null
    ? { name: "", cwd: null, leave: "Cancel", folderFixed: false, className: "form" }
    : {
        name: baseName(chosenDir),
        cwd: chosenDir,
        leave: "Back",
        folderFixed: true,
        className: "form form--confirm",
      };
}
