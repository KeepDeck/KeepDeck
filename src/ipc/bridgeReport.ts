/**
 * One opaque report a pane's reporter sent through the bridge, as the bridge
 * passes it on — the one shape of every lane that carries its payload
 * verbatim (usage, status, unbindings, companions). Mirrors the Rust
 * `Report` (src-tauri/src/bridge/wire.rs, camelCase).
 */
export interface BridgeReport {
  paneId: string;
  /** The per-spawn bridge secret, verified against the pane's plan. */
  token: string;
  /** The process that sent it, as the bridge read it for its own origin
   * check — the one reading of the payload's `reporter`. Absent when it
   * named none. */
  reporter?: string;
  /** The reporter's own words, opaque here: the agent's normalizers own
   * them. */
  payload: unknown;
}
