import { invoke } from "@tauri-apps/api/core";
import type { HttpAnswer } from "@keepdeck/plugin-api";

/** A credential source as resolved, with the file a request names in it. */
export interface HttpCredential {
  dir: string;
  file: string;
  tokenFields: readonly string[];
}

/**
 * One bounded GET (mirrors the Rust `plugin_http_get`). The gate passes the
 * reach the plugin's declaration resolved to — for a signed request, the
 * reach of the entry that declares the source — and the host admits the URL
 * against it, reads the token confined to the directory, and follows no
 * redirect.
 */
export function pluginHttpGet(
  allowed: readonly string[],
  url: string,
  credential: HttpCredential | undefined,
  accept: string | undefined,
): Promise<HttpAnswer> {
  return invoke<HttpAnswer>("plugin_http_get", {
    allowed,
    url,
    credential: credential ?? null,
    accept: accept ?? null,
  });
}
