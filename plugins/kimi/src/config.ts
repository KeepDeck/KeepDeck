import type { PluginEnv, PluginFs } from "@keepdeck/plugin-api";
import { isJsonRecord } from "@keepdeck/plugin-api";
import { parse } from "smol-toml";
import { kimiHome } from "./home";

/**
 * kimi's `config.toml`, read and parsed in ONE place for everything the
 * plugin takes from it: the managed login the limits read signs with
 * (./limits.ts) and the model table the context gauge measures against
 * (./models.ts). kimi writes the file itself at login and when it refreshes
 * its models; the plugin only reads it.
 */

/** The parsed file — read through its owners, never as raw text. */
export type KimiConfig = Readonly<Record<string, unknown>>;

/** The file's text parsed, or undefined for none, a cut read, or one that
 * does not parse — every one of which reads as "nothing configured", as
 * kimi reads it. */
export function parseKimiConfig(text: string | null): KimiConfig | undefined {
  if (text === null) return undefined;
  let config: unknown;
  try {
    config = parse(text);
  } catch {
    return undefined;
  }
  return isJsonRecord(config) ? config : undefined;
}

export interface KimiConfigPorts {
  fs: Pick<PluginFs, "readFile">;
  env: PluginEnv;
}

/** One read of the config under kimi's home (`KIMI_CODE_HOME` or the
 * default), parsed. */
export async function readKimiConfig(services: KimiConfigPorts): Promise<KimiConfig | undefined> {
  const home = await kimiHome(services.env);
  const file = await services.fs.readFile(`${home}/config.toml`).catch(() => null);
  return parseKimiConfig(file && !file.truncated ? file.text : null);
}
