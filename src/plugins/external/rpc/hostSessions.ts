import type {
  PluginContext,
  PluginSessionEvent,
  PluginSessionHandle,
  PluginSpawnOptions,
} from "@keepdeck/plugin-api";
import { sessionChannel, type WireSessionEvent } from "./protocol";

/**
 * The host end of a guest's PTY sessions. `spawn` is the one call in the whole
 * contract that takes a callback (`onEvent`), so it gets special handling: the
 * host keeps the callback on THIS side, wires it to a `session:<id>` push, and
 * returns only the serializable `{ id }` the guest needs to build a handle
 * façade. Subsequent `write`/`resize`/`close` arrive as plain calls carrying the
 * id, which we route back to the RETAINED live handle.
 *
 * Retention is the whole point: an external plugin lives in an iframe realm that
 * can vanish (crash, navigation, deactivation). A leaked PTY would outlive it,
 * so `disposeAll` closes every handle the realm still holds when the bridge dies.
 */
export interface HostSessions {
  spawn(opts: PluginSpawnOptions): Promise<{ id: string }>;
  write(id: string, data: string): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  close(id: string): Promise<void>;
  disposeAll(): void;
}

export function createHostSessions(
  ctx: PluginContext,
  push: (channel: string, payload: unknown) => void,
): HostSessions {
  const handles = new Map<string, PluginSessionHandle>();

  function handleOf(id: string): PluginSessionHandle {
    const handle = handles.get(id);
    if (!handle) throw new Error(`unknown session: ${id}`);
    return handle;
  }

  return {
    async spawn(opts) {
      // `onEvent` reads `sessionId` lazily. The contract makes `spawn` async
      // precisely so the id exists before events flow: the backend only calls
      // `onEvent` after it has resolved the handle (and the result has crossed
      // back to the guest), so the empty-string seed is never observed on the
      // wire.
      let sessionId = "";
      const onEvent = (event: PluginSessionEvent) =>
        push(sessionChannel(sessionId), toWire(event));
      const handle = await ctx.services.sessions.spawn(opts, onEvent);
      sessionId = handle.id;
      handles.set(sessionId, handle);
      return { id: sessionId };
    },
    write(id, data) {
      return handleOf(id).write(data);
    },
    resize(id, cols, rows) {
      return handleOf(id).resize(cols, rows);
    },
    close(id) {
      const handle = handleOf(id);
      handles.delete(id);
      return handle.close();
    },
    disposeAll() {
      for (const handle of handles.values()) {
        // The realm is gone; the process group must not outlive it. A close that
        // throws is swallowed — there is nothing left to report it to.
        try {
          void handle.close();
        } catch {
          /* the session is already unreachable — nothing to salvage */
        }
      }
      handles.clear();
    },
  };
}

/** Serialize a `PluginSessionEvent` for the wire: `output.bytes` becomes a plain
 * `number[]` (the guest re-hydrates it to a `Uint8Array`), so no typed array has
 * to survive the realm crossing. */
function toWire(event: PluginSessionEvent): WireSessionEvent {
  return event.type === "output"
    ? { type: "output", bytes: Array.from(event.bytes) }
    : { type: "exit", code: event.code };
}
