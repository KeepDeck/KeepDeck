import { invoke } from "@tauri-apps/api/core";
import type { HttpAnswer, HttpGet } from "@keepdeck/plugin-api";

/**
 * One bounded GET on a plugin's behalf (mirrors the Rust `plugin_http_get`).
 * Only the plugin and its request travel: the host looks up the reach and
 * the credential source in that plugin's resolved grant, admits the URL
 * against it, reads the token confined to the source's directory, and
 * follows no redirect.
 */
export function pluginHttpGet(pluginId: string, request: HttpGet): Promise<HttpAnswer> {
  return invoke<HttpAnswer>("plugin_http_get", {
    pluginId,
    url: request.url,
    credential: request.credential ?? null,
    accept: request.accept ?? null,
  });
}
