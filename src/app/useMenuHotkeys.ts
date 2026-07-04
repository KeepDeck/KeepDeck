import { useEffect, useRef } from "react";
import { describeError, log } from "../ipc/log";
import {
  CLOSE_AGENT_EVENT,
  NEW_AGENT_EVENT,
  NEW_WORKSPACE_EVENT,
  SETTINGS_EVENT,
  TOGGLE_MAXIMIZE_EVENT,
  onMenuEvent,
} from "../ipc/menu";

export interface MenuActions {
  /** File → New Workspace… (⌘N). */
  newWorkspace(): void;
  /** File → New Agent… (⌘T). */
  newAgent(): void;
  /** File → Close Agent (⌘W); in an empty workspace closes the workspace. */
  closeAgent(): void;
  /** View → Toggle Maximize Agent (⇧⌘M). */
  toggleMaximize(): void;
  /** Settings… (⌘,) — the app submenu on macOS, File elsewhere ([F6]). */
  openSettings(): void;
}

/**
 * Bind the native menu's hotkey events to the given actions. The menu owns the
 * accelerators (macOS resolves them before the webview sees the key), so these
 * arrive as deck events. The subscription mounts once; a ref keeps it calling
 * the latest actions, whose guards close over fresh render state.
 */
export function useMenuHotkeys(actions: MenuActions) {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const subscribe = (event: string, action: keyof MenuActions) => {
      onMenuEvent(event, () => ref.current[action]())
        .then((un) => {
          if (cancelled) un();
          else unlisteners.push(un);
        })
        .catch((e) =>
          log.warn("web:menu", `subscribing ${event} failed: ${describeError(e)}`),
        );
    };
    subscribe(NEW_WORKSPACE_EVENT, "newWorkspace");
    subscribe(NEW_AGENT_EVENT, "newAgent");
    subscribe(CLOSE_AGENT_EVENT, "closeAgent");
    subscribe(TOGGLE_MAXIMIZE_EVENT, "toggleMaximize");
    subscribe(SETTINGS_EVENT, "openSettings");
    return () => {
      cancelled = true;
      unlisteners.forEach((un) => un());
    };
  }, []);
}
