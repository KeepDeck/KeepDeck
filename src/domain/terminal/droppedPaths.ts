/** Bracketed paste (xterm's mode 2004): what a terminal sends around pasted text. */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Format dropped file paths for a pane's input, given (from the backend, by file
 * content — see `paths_are_images`) which ones are images. Generic terminal
 * policy, the same for every agent: an image path is sent as a bracketed paste,
 * which is how a terminal hands a pasted file over, so agent TUIs attach it;
 * every other path (regular file or FOLDER) is inserted RAW, because at least
 * one agent's paste handler drops a bracketed path that is not an image (seen
 * in the field), and raw is safe for all. Every bundled agent was checked live
 * (task-516). No shell quoting (the target is a text prompt, not a shell —
 * quoting corrupts the path); paths are space-joined.
 */
export function formatDroppedPaths(paths: string[], isImage: boolean[]): string {
  return paths
    .map((p, i) => (isImage[i] ? `${PASTE_START}${p}${PASTE_END}` : p))
    .join(" ");
}
