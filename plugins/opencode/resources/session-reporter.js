/**
 * KeepDeck session reporter — an opencode plugin.
 *
 * Injected PER SPAWN via the `OPENCODE_CONFIG_CONTENT` env var (which MERGES
 * into the user's config; nothing is installed or modified on their side) and
 * referenced by absolute path inside KeepDeck's resources. It runs inside the
 * pane's own opencode process, so `process.env` carries the single
 * `KEEPDECK_BRIDGE` var KeepDeck injected at spawn ({v, dir, pane, token}) —
 * attribution is exact even when several agents spawn in parallel, and `/new`
 * typed inside the TUI is caught too.
 *
 * Every `session.created` in this process becomes a bridge-protocol-v1
 * `session.bound` envelope in the bridge inbox — a uniquely named file
 * (randomUUID, so parallel events never collide), written as `.tmp` and
 * renamed so the watcher never sees a torn file. Reporting is best-effort: a
 * KeepDeck-less environment (or a full disk) must never break the user's
 * session.
 */
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default async () => {
  let bridge;
  try {
    bridge = JSON.parse(process.env.KEEPDECK_BRIDGE ?? "");
  } catch {
    return {}; // not spawned by KeepDeck — stay inert
  }
  const { dir, pane, token } = bridge ?? {};
  if (!dir || !pane || !token) return {};

  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created") return;
      const sessionId = event.properties?.info?.id;
      if (!sessionId) return;
      try {
        const base = join(dir, `session.bound-${randomUUID()}`);
        writeFileSync(
          `${base}.tmp`,
          JSON.stringify({
            v: 1,
            type: "session.bound",
            paneId: pane,
            token,
            payload: { sessionId, agent: "opencode" },
          }),
        );
        renameSync(`${base}.tmp`, `${base}.json`);
      } catch {
        // best-effort by design
      }
    },
  };
};
