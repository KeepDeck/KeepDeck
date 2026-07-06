import type { RpcResult } from "./protocol";

/**
 * The guest's request/response client over the `MessagePort`. It owns exactly
 * one concern: turn a `call(path, args)` into a promise, and settle that promise
 * when the matching `result` comes back. Ids are a monotonic counter — never
 * reused within a realm's life — so a late result can only ever match the one
 * call it belongs to (or nothing, if that call was already settled or the realm
 * moved on).
 *
 * Lifecycle messages (`ready`/`activated`/`failed`) and event fan-out live in
 * `connect`/`context`; this class stays a pure correlator so it is trivial to
 * reason about and to test in isolation.
 */
export class GuestRpc {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();

  constructor(private readonly port: MessagePort) {}

  /** Invoke a host method; resolves with its return value, rejects with an
   * `Error` carrying the host's message on `ok:false`. */
  call(path: string, args: unknown[]): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.port.postMessage({ kind: "call", id, path, args });
    });
  }

  /** Settle the pending promise for one incoming result. Unknown ids (already
   * settled, or never ours) are ignored — a result is at most one promise. */
  settle(result: RpcResult): void {
    const entry = this.pending.get(result.id);
    if (!entry) return;
    this.pending.delete(result.id);
    if (result.ok) entry.resolve(result.value);
    else entry.reject(new Error(result.error));
  }
}
