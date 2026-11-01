import { paneRunsYolo, type PaneYoloStart } from "../presentation/paneYolo";
import { usePaneMode } from "./usePaneMode";

/**
 * Whether ONE pane wears the YOLO badge — the presentation's answer, fed the
 * agent's own word from the status tracker. One hook for every surface that
 * shows the badge, so the grid and the tray cannot answer differently.
 */
export function usePaneRunsYolo(paneId: string, start: PaneYoloStart): boolean {
  return paneRunsYolo({ said: usePaneMode(paneId), ...start });
}
