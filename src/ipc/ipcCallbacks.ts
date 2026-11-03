import { isJsonRecord } from "@keepdeck/plugin-api";

/** How many invoke callbacks the Tauri IPC glue still holds.
 *
 * Every `invoke` registers two one-shot callbacks (resolve and reject) in the
 * glue's `callbacks` map and removes both when its answer arrives
 * (`tauri/scripts/core.js`). A call whose answer never comes leaves both
 * behind for good, together with its promise and closures. The map is exposed
 * by Tauri for debugging; reading its size is the one way to tell, from
 * inside the page, whether unanswered calls are piling up.
 *
 * `null` when there is no Tauri glue to ask (tests, plain vite) — an absent
 * answer, never a zero that would read as "nothing pending". */
export function pendingIpcCallbacks(): number | null {
  const internals: unknown = Reflect.get(globalThis, "__TAURI_INTERNALS__");
  if (!isJsonRecord(internals)) return null;
  const callbacks = internals.callbacks;
  return callbacks instanceof Map ? callbacks.size : null;
}
