import { isJsonRecord, type PluginEnv } from "@keepdeck/plugin-api";
import manifest from "../manifest.json";

/**
 * kimi's own variables, as kimi reads them: `KIMI_CODE_HOME` moves its whole
 * home, `KIMI_CODE_BASE_URL` its API. The plugin declares both (`env`), and
 * the host resolves the same declaration for the token directory and the
 * origins a signed request may reach — so the defaults live in ONE place,
 * the manifest, and are read from it here rather than restated.
 */
export const KIMI_HOME_VAR = "KIMI_CODE_HOME";
export const KIMI_BASE_URL_VAR = "KIMI_CODE_BASE_URL";

/** The default the manifest declares for `variable` — on a net domain or a
 * credentials directory. */
export function declaredDefault(variable: string): string {
  const capabilities: unknown = manifest.capabilities;
  const references = (Array.isArray(capabilities) ? capabilities : []).flatMap((capability: unknown) => {
    if (!isJsonRecord(capability) || capability.kind !== "net") return [];
    const domains = Array.isArray(capability.domains) ? capability.domains : [];
    const credentials = Array.isArray(capability.credentials) ? capability.credentials : [];
    return [...domains, ...credentials.map((source: unknown) => (isJsonRecord(source) ? source.dir : null))];
  });
  for (const reference of references) {
    if (isJsonRecord(reference) && reference.env === variable && typeof reference.default === "string") {
      return reference.default;
    }
  }
  throw new Error(`the kimi manifest declares no default for ${variable}`);
}

/** kimi's home: the variable when set and not empty, else the default — the
 * same rule the host applies to the token directory. */
export async function kimiHome(env: PluginEnv): Promise<string> {
  const home = await env.get(KIMI_HOME_VAR);
  return home ? home : declaredDefault(KIMI_HOME_VAR);
}
