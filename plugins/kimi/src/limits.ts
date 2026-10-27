import type { LimitsRead, PluginEnv, PluginFs, PluginHttp } from "@keepdeck/plugin-api";
import { asNonEmptyString, isJsonRecord } from "@keepdeck/plugin-api";
import { parse } from "smol-toml";
import { declaredDefault, KIMI_BASE_URL_VAR, kimiHome } from "./home";

/**
 * kimi's account limits. Its rate windows exist nowhere on disk (its own
 * `/usage` asks the network too), so they are read from the coding usages
 * endpoint, signed with the token kimi keeps under its home.
 *
 * WHICH endpoint and WHICH token file are kimi's login, not a constant: a
 * mainland login talks to `api.kimi.com` with `kimi-code.json`, a global one
 * to `api.kimi.ai` with a `kimi-code-env-<hash>.json` of its own. kimi
 * records both in `config.toml` under the managed provider, and this reads
 * them from there rather than re-deriving kimi's region rules.
 *
 * Read-only on the token: it lives ~15 minutes and kimi refreshes it while
 * it runs, so a 401 means no live kimi activity — the lane lets the last
 * snapshot age, nothing here refreshes the token. The host reads the token
 * itself and the plugin never sees it.
 */

/** The credential source the manifest declares for kimi's token files. */
const CREDENTIAL_SOURCE = "kimi-code";
/** The token file of a mainland login, `oauth/kimi-code` in kimi's terms. */
const DEFAULT_TOKEN_NAME = "kimi-code";

export interface UsageSource {
  url: string;
  /** A plain file name inside the credentials directory. */
  file: string;
}

/** kimi's credential key → its file name, as kimi maps it
 * (`resolveKimiTokenStorageName`): `oauth/<name>` stores as `<name>`, a bare
 * name as itself. Anything that could leave the directory — a nested path,
 * a dot name — is refused, as kimi refuses it. */
export function tokenStorageName(key: string): string | null {
  const name = key.startsWith("oauth/") ? key.slice("oauth/".length) : key;
  return name !== "" && !name.includes("/") && !name.includes("\\") && !name.startsWith(".") ? name : null;
}

/** The managed login kimi recorded → the usages URL and the token file.
 * `KIMI_CODE_BASE_URL` overrides the URL when set, as it does for kimi —
 * even set empty, which makes a URL the host refuses rather than a quiet
 * fallback. A config that is missing, unparsable, or names no managed login
 * reads as the mainland default, as kimi does. Null only for a token key
 * that would name a file outside the credentials directory. */
export function usageSource(
  configToml: string | null,
  envBaseUrl: string | null,
  defaultBaseUrl: string,
): UsageSource | null {
  const provider = managedProvider(configToml);
  const base = envBaseUrl ?? asNonEmptyString(provider?.base_url) ?? defaultBaseUrl;
  const oauth = provider?.oauth;
  const key = isJsonRecord(oauth) ? asNonEmptyString(oauth.key) : undefined;
  const name = key === undefined ? DEFAULT_TOKEN_NAME : tokenStorageName(key);
  if (name === null) return null;
  return { url: `${base.replace(/\/+$/, "")}/usages`, file: `${name}.json` };
}

function managedProvider(configToml: string | null): Record<string, unknown> | undefined {
  if (configToml === null) return undefined;
  let config: unknown;
  try {
    config = parse(configToml);
  } catch {
    return undefined;
  }
  const providers = isJsonRecord(config) ? config.providers : undefined;
  const provider = isJsonRecord(providers) ? providers["managed:kimi-code"] : undefined;
  return isJsonRecord(provider) ? provider : undefined;
}

export interface LimitsPorts {
  services: {
    fs: Pick<PluginFs, "readFile">;
    http: PluginHttp;
    env: PluginEnv;
  };
}

/** One read of the usages document, for the host's limits lane. */
export async function readKimiLimits({ services }: LimitsPorts): Promise<LimitsRead> {
  const home = await kimiHome(services.env);
  const config = await services.fs.readFile(`${home}/config.toml`).catch(() => null);
  const source = usageSource(
    config && !config.truncated ? config.text : null,
    await services.env.get(KIMI_BASE_URL_VAR),
    declaredDefault(KIMI_BASE_URL_VAR),
  );
  if (!source) throw new Error("kimi config names a credentials key outside its credentials directory");
  const answer = await services.http.get({
    url: source.url,
    credential: { source: CREDENTIAL_SOURCE, file: source.file },
  });
  // The status matters to the lane's log line: 401 means the token is idle.
  if (answer.status !== 200) throw new Error(`kimi usages HTTP ${answer.status}`);
  if (answer.truncated) throw new Error("kimi usages answer is larger than the host carries");
  return { body: answer.body, sourceAt: answer.sentAt };
}
