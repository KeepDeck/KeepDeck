import { listen } from "@tauri-apps/api/event";

/** Webview events emitted by the native menu — the IPC contract with
 * `src-tauri/src/menu.rs`. The hotkey accelerators live on menu items because
 * macOS resolves them at the menu layer: a ⌘W keydown never reaches the
 * webview, it arrives as one of these events. */
export const NEW_AGENT_EVENT = "deck://menu/new-agent";
export const CLOSE_AGENT_EVENT = "deck://menu/close-agent";

/** Subscribe to one of the menu events; resolves to an unlisten fn. */
export function onMenuEvent(
  event: string,
  handler: () => void,
): Promise<() => void> {
  return listen(event, handler);
}
