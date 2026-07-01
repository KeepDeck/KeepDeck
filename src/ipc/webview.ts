import { getCurrentWebview } from "@tauri-apps/api/webview";

/** An OS file drop on the window, in viewport CSS pixels. */
export interface FileDrop {
  x: number;
  y: number;
  paths: string[];
}

/**
 * Subscribe to OS file drops. In a Tauri webview these do NOT fire DOM drag
 * events — only Tauri's onDragDropEvent, whose position is already viewport
 * CSS pixels. The drop can fire twice (tauri#14134), so duplicates within
 * 400ms are collapsed here. Resolves to an unlisten fn.
 */
export function onFileDrop(
  handler: (drop: FileDrop) => void,
): Promise<() => void> {
  let lastDropAt = 0;
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== "drop" || event.payload.paths.length === 0)
      return;
    const now = Date.now();
    if (now - lastDropAt < 400) return;
    lastDropAt = now;
    const { x, y } = event.payload.position;
    handler({ x, y, paths: event.payload.paths });
  });
}
