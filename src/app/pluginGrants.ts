/**
 * What each installed plugin's `env` and `net` resolved to — taken once,
 * before it is installed — and the native grant made from the same
 * declaration. The gate, consent and its words read the resolution here;
 * the native side holds the grant by plugin id — the reach for http and
 * downloads, the declared fsWrite and sqlite prefixes — and never takes any
 * of it from a caller.
 *
 * One owner for the whole lifetime: resolving, the policy for a declaration
 * that does not resolve, and dropping the grant when a plugin is gone.
 */
import { errorMessage } from "@keepdeck/plugin-api";
import type { PluginInstall } from "../plugins";
import {
  isResolvedPermissions,
  NO_PERMISSIONS,
  type ResolvedPermissions,
} from "../plugins/capabilities";

export interface PluginGrantsDeps {
  /** Resolve natively and keep the result as the plugin's grant; rejects
   * with a named code (the variable included) when it cannot resolve. */
  resolve(pluginId: string, capabilities: PluginInstall["manifest"]["capabilities"]): Promise<unknown>;
  /** Drop the plugin's native grant. */
  forget(pluginId: string): Promise<void>;
  logger(pluginId: string): { warn(message: string): void; error(message: string): void };
}

export interface PluginGrants {
  /** What the plugin's declaration resolved to; nothing when it did not
   * resolve. */
  resolved(pluginId: string): ResolvedPermissions | undefined;
  /** {@link resolved}, or no permissions at all. */
  permissionsOf(pluginId: string): ResolvedPermissions;
  /** Resolve before install — every plugin, so the native grant holds its
   * declared prefixes even when it declares no `env` or `net`. A declaration
   * that cannot resolve — a variable holding a malformed URL, a credentials
   * root that bounds nothing — never quietly widens or narrows what the
   * plugin may reach: it gets no reach at all, and the error says what
   * failed. An external plugin then fails by name, holding nothing: there is
   * nothing to consent to. A built-in still installs, with no env and no
   * net and its prefixes kept — its agent stays in the catalog, and only
   * what needs that reach fails, where it is used. */
  prepare(install: PluginInstall, tier: "builtin" | "external"): Promise<PluginInstall>;
  /** The plugin is gone: its resolution and its native grant go with it. */
  drop(pluginId: string): Promise<void>;
}

export function createPluginGrants(deps: PluginGrantsDeps): PluginGrants {
  const resolutions = new Map<string, ResolvedPermissions>();

  /** A failure to drop is said, not thrown: the grant of a plugin that is
   * gone authorizes a caller nothing reaches. */
  async function forget(pluginId: string): Promise<void> {
    try {
      await deps.forget(pluginId);
    } catch (error) {
      deps.logger(pluginId).warn(`its native grant could not be dropped: ${errorMessage(error)}`);
    }
  }

  return {
    resolved: (pluginId) => resolutions.get(pluginId),
    permissionsOf: (pluginId) => resolutions.get(pluginId) ?? NO_PERMISSIONS,

    async prepare(install, tier) {
      const { manifest } = install;
      resolutions.delete(manifest.id);
      let failure: string;
      let readable = true;
      try {
        const resolved = await deps.resolve(manifest.id, manifest.capabilities);
        if (isResolvedPermissions(resolved)) {
          resolutions.set(manifest.id, resolved);
          return install;
        }
        readable = false;
        failure = "its environment and network declaration resolved to an unreadable answer";
      } catch (error) {
        failure = `its environment and network declaration did not resolve: ${errorMessage(error)}`;
      }
      // A grant this side could not read is none it can vouch for, and an
      // external plugin that will not run holds nothing.
      if (!readable || tier === "external") await forget(manifest.id);
      if (tier === "builtin") {
        deps.logger(manifest.id).error(`${failure} — it runs without its environment and network`);
        return install;
      }
      deps.logger(manifest.id).error(failure);
      return {
        manifest,
        load: async () => {
          throw new Error(failure);
        },
      };
    },

    async drop(pluginId) {
      resolutions.delete(pluginId);
      await forget(pluginId);
    },
  };
}
