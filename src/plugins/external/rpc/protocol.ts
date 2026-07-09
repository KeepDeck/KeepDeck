import type { PluginManifest } from "@keepdeck/plugin-api";

/**
 * The wire format of the external tier's plugin bridge — the ONE vocabulary
 * both ends speak. The host embeds this module directly; the guest package
 * re-exports it (`@keepdeck/plugin-guest` → `./protocol.ts`), so there is a
 * single source of truth for the shapes that cross the postMessage seam.
 *
 * Two rules keep it honest:
 *
 * 1. **Dependency-free.** The only import is a TYPE (`PluginManifest`), erased
 *    at build time — nothing here pulls host code into a plugin bundle. The
 *    module is a description of bytes, not behaviour.
 * 2. **Structured-clone-safe.** Every field is plain data: strings, numbers,
 *    arrays, records. Callbacks never cross the wire — the two callback shapes
 *    the contract has (subscriptions, session spawn) are modelled as `event`
 *    pushes, and typed arrays are carried as `number[]` for predictable cloning
 *    across the two iframe realms (a Uint8Array survives structured clone, but
 *    a plain array is the lowest-common-denominator the host and guest agree on
 *    without depending on either realm's ArrayBuffer identity).
 *
 * Directionality is encoded in the two union types, not merely documented, so a
 * mis-sent message is a type error at the send site.
 */

// --------------------------------------------------------------- guest → host

/** A method invocation on the host's real `PluginContext`. `path` is a dot-path
 * into the context surface (`"storage.workspace.get"`, `"log.info"`,
 * `"services.sessions.spawn"`); `args` are the leading positional arguments,
 * with any callback position modelled separately (see the module docs). Each
 * call carries a monotonic `id` the host echoes back on its `result`. */
export interface RpcCall {
  kind: "call";
  id: number;
  path: string;
  args: unknown[];
}

/** The guest has loaded its logic bundle and is ready to receive the manifest.
 * Sent once, before anything else. */
export interface RpcReady {
  kind: "ready";
}

/** The plugin's `activate` completed. Sent after every registration call the
 * plugin made, so by the time the host sees this its registries are populated
 * (postMessage preserves order). */
export interface RpcActivated {
  kind: "activated";
}

/** The plugin's `activate` threw (or rejected). Carries the one-line reason. */
export interface RpcFailed {
  kind: "failed";
  error: string;
}

export type GuestToHostMessage = RpcCall | RpcReady | RpcActivated | RpcFailed;

// --------------------------------------------------------------- host → guest

/** The reply to one `RpcCall`, keyed by the same `id`. Success carries the
 * awaited return value; failure carries a one-line message (an unknown `path`,
 * a throwing member, or the bridge being disposed mid-flight) — the host never
 * lets a plugin call crash it, it answers with `ok:false`. */
export type RpcResult =
  | { kind: "result"; id: number; ok: true; value: unknown }
  | { kind: "result"; id: number; ok: false; error: string };

/** A host-initiated push on a named channel — the wire form of every callback
 * the guest registered. `payload` is the serialized event body (see the channel
 * builders below for the shapes). */
export interface RpcEvent {
  kind: "event";
  channel: string;
  payload: unknown;
}

/** The host hands the guest its validated manifest. The guest builds its
 * context from it and runs `activate`; `ctx.manifest` on the guest side is this
 * value, mirroring how the built-in tier passes the manifest to its context. */
export interface RpcInit {
  kind: "init";
  manifest: PluginManifest;
}

export type HostToGuestMessage = RpcResult | RpcEvent | RpcInit;

// ------------------------------------------------------------------ channels

/**
 * The well-known static push channels. The deck-event and settings channels are
 * fixed strings; session and action channels are parameterised by id (see the
 * builders) because a plugin holds many of each at once.
 */
export type EventChannel =
  | "workspaceClosed"
  | "paneSelected"
  | "deckChanged"
  | "settingsChanged"
  | `session:${string}`
  | `action:${string}`
  | `fswatch:${string}`
  | `hook:${string}`;

/** The three deck-lifecycle channels a guest may subscribe to by name via
 * `events.subscribe`. Kept as a value so the host can validate an incoming
 * channel name instead of trusting the guest. */
export const DECK_EVENT_CHANNELS = [
  "workspaceClosed",
  "paneSelected",
  "deckChanged",
] as const;

export type DeckEventChannel = (typeof DECK_EVENT_CHANNELS)[number];

/** The push channel for one live session's events (`output`/`exit`). The guest
 * learns the id from the `spawn` result, then routes this channel back to the
 * caller's `onEvent`. */
export function sessionChannel(sessionId: string): `session:${string}` {
  return `session:${sessionId}`;
}

/** The push channel for one action's `run` firing. The host cannot send the
 * plugin's callback across the wire, so it registers a contribution whose
 * `run()` pushes this channel; the guest fans it back out to the real callback.
 * `kind` distinguishes the two action surfaces that share an id namespace. */
export function actionChannel(
  kind: "topBar" | "pane",
  id: string,
): `action:${string}` {
  return `action:${kind}:${id}`;
}

/** The push channel for one directory watch's change signal. The guest mints
 * the id, the host pushes this channel (empty payload) on each change. */
export function fswatchChannel(id: number): `fswatch:${string}` {
  return `fswatch:${id}`;
}

/** The push channel for ONE agent-hook invocation (host→guest). The host
 * mints the id and pushes a `WireHookCall`; the guest runs the plugin's hook
 * and answers with an `agents.hookResult` call carrying the same id. */
export function hookChannel(id: number): `hook:${string}` {
  return `hook:${id}`;
}

// ------------------------------------------------------------- session bodies

/** The wire form of a `PluginSessionEvent`. `output.bytes` is a `number[]`, not
 * a `Uint8Array`: the guest re-hydrates it before the plugin's `onEvent` sees
 * it, so the typed-array shape never has to survive the realm crossing. */
export type WireSessionEvent =
  | { type: "output"; bytes: number[] }
  | { type: "exit"; code: number | null };

// ---------------------------------------------------------------- hook bodies

/** The serializable half of a `SpawnPlanOutput` — what an agent hook mutates
 * across the wire. */
export interface WireSpawnPlanOutput {
  command: string | null;
  args: string[];
  env: [string, string][];
}

/** The payload of one `hook:<id>` push: which agent, which hook, and the
 * input/output pair (both plain data — the mutate-in-place contract crosses
 * the wire as "send both, return the mutated output"). */
export interface WireHookCall {
  agentId: string;
  hook: string;
  input: unknown;
  output: WireSpawnPlanOutput;
}
