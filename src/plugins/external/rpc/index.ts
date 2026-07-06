/**
 * The external tier's RPC bridge — the host half. A `MessagePort` to a plugin's
 * realm plus the plugin's `PluginContext` in, a live bridge out. The protocol
 * types are re-exported so the host imports the wire vocabulary from one place;
 * the guest package (`@keepdeck/plugin-guest`) re-exports the SAME protocol
 * module for its half.
 */
export { createHostBridge, type HostBridge } from "./hostBridge";
export type {
  EventChannel,
  GuestToHostMessage,
  HostToGuestMessage,
  RpcCall,
  RpcEvent,
  RpcInit,
  RpcResult,
  WireSessionEvent,
} from "./protocol";
export {
  actionChannel,
  DECK_EVENT_CHANNELS,
  sessionChannel,
} from "./protocol";
