/**
 * KeepDeck session reporter — an opencode plugin.
 *
 * Injected PER SPAWN via the `OPENCODE_CONFIG_CONTENT` env var (which MERGES
 * into the user's config; nothing is installed or modified on their side) and
 * referenced by absolute path inside KeepDeck's resources. It runs inside the
 * pane's own opencode process, so `process.env` carries the pane identity
 * KeepDeck injected at spawn — attribution is exact even when several agents
 * spawn in parallel, and `/new` typed inside the TUI is caught too.
 *
 * Every `session.created` in this process is reported to the KeepDeck spool
 * as `{paneId, sessionId}`; the Rust watcher picks it up and binds the pane.
 * Reporting is best-effort: a KeepDeck-less environment (or a full disk) must
 * never break the user's session.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default async () => {
  const paneId = process.env.KEEPDECK_PANE_ID;
  const spool = process.env.KEEPDECK_SPOOL;
  if (!paneId || !spool) return {}; // not spawned by KeepDeck — stay inert

  let seq = 0;
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created") return;
      const sessionId = event.properties?.info?.id;
      if (!sessionId) return;
      try {
        // tmp + rename so the spool watcher never sees a torn file.
        const base = join(spool, `${paneId}-${Date.now()}-${seq++}`);
        writeFileSync(
          `${base}.tmp`,
          JSON.stringify({ paneId, sessionId, agent: "opencode" }),
        );
        renameSync(`${base}.tmp`, `${base}.json`);
      } catch {
        // best-effort by design
      }
    },
  };
};
