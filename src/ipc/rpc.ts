import { invoke } from "@tauri-apps/api/core";
import type { JsonValue, RpcAnswer, RpcServerDeclaration } from "@keepdeck/plugin-api";

/**
 * Call a method of a plugin's declared JSON-RPC server (mirrors the Rust
 * `plugin_rpc_request`). The capability gate has bound `server` to the
 * plugin's manifest; the host still refuses on its own a method outside the
 * declaration, the handshake, and a command that is a path.
 */
export async function pluginRpcRequest(
  pluginId: string,
  server: RpcServerDeclaration,
  method: string,
  params: JsonValue | undefined,
): Promise<RpcAnswer> {
  return await invoke<RpcAnswer>("plugin_rpc_request", {
    pluginId,
    server: {
      id: server.id,
      command: server.command,
      args: server.args,
      handshake: server.handshake ?? null,
      methods: server.methods,
    },
    method,
    params: params ?? null,
  });
}

/** Stop every JSON-RPC child of a plugin that went away. */
export async function pluginRpcStop(pluginId: string): Promise<void> {
  await invoke("plugin_rpc_stop", { pluginId });
}
