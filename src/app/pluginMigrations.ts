import type { PluginLogger, PluginManifest } from "@keepdeck/plugin-api";
import { adoptPluginDownloads } from "../ipc/downloads";

export function hasBuiltinOnlyDownloadMigrations(
  manifest: PluginManifest,
): boolean {
  return manifest.capabilities.some(
    (capability) => capability.kind === "legacyDownloads",
  );
}

/** Run declarative compatibility work before the bundled plugin activates. */
export async function applyBuiltinDownloadMigrations(
  manifest: PluginManifest,
  log: PluginLogger,
): Promise<void> {
  for (const capability of manifest.capabilities) {
    if (capability.kind !== "legacyDownloads") continue;
    for (const migration of capability.migrations) {
      try {
        await adoptPluginDownloads(manifest.id, migration);
      } catch (error) {
        log.warn(
          `legacy download migration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
