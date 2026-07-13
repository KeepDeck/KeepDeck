import type {
  Capability,
  PluginLogger,
  PluginManifest,
} from "@keepdeck/plugin-api";
import { matchesAnyPattern, type CommandRegistry } from "../../domain/commands";
import type { PluginCommandsPort } from "../host/deps";

/**
 * One plugin's window onto the command registry — the `commands` half of the
 * capability model, mirroring what the gate does for services:
 *
 * - `register` DERIVES the registry id (`<pluginId>.<entryId>`), so a plugin
 *   can only ever contribute under its own namespace; the context has already
 *   checked the manifest declared the entry.
 * - `execute` admits the plugin's own namespace unconditionally (registering
 *   implies invoking your own) and everything else only when the manifest's
 *   `commands` capability patterns cover it. A refusal is a RESULT, not a
 *   throw — invokers get one uniform error channel on both tiers, and a
 *   violation still lands in the log.
 */
export function createPluginCommandsPort(
  manifest: PluginManifest,
  registry: CommandRegistry,
  log: PluginLogger,
): PluginCommandsPort {
  const pluginId = manifest.id;
  const patterns =
    manifest.capabilities.find(
      (c): c is Extract<Capability, { kind: "commands" }> =>
        c.kind === "commands",
    )?.execute ?? [];

  return {
    register(spec) {
      const off = registry.register({
        id: `${pluginId}.${spec.id}`,
        title: spec.title,
        args: spec.args,
        destructive: spec.destructive,
        run: spec.run,
      });
      return { dispose: off };
    },
    async execute(id, args) {
      if (!id.startsWith(`${pluginId}.`) && !matchesAnyPattern(patterns, id)) {
        const message = `commands.execute: "${id}" requires a "commands" capability covering it, which the manifest does not declare`;
        log.warn(message);
        return { ok: false, error: { code: "not-permitted", message } };
      }
      return registry.execute(id, args, { kind: "plugin", pluginId });
    },
    async list() {
      return registry.list();
    },
  };
}
