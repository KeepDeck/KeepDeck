import type { AgentHistory } from "@keepdeck/plugin-api";
import {
  indexPrune,
  indexRefs,
  indexUpsert,
  type IndexRowInput,
} from "../ipc/history";
import { describeError, log } from "../ipc/log";

/** How many changed sessions are described/read per upsert batch — bounds
 * memory on a first-ever scan of a thousand-session store. */
const BATCH = 16;

/** Per-session cap on indexed text — bounds index growth and the IPC hop;
 * search over the first 2 MB of a conversation is search enough. */
const CONTENT_CAP = 2 * 1024 * 1024;

export interface HistorySource {
  agentId: string;
  history: AgentHistory;
}

/** Injected index ops (the ipc surface) — swapped in tests. */
export interface ScanIndexOps {
  refs: typeof indexRefs;
  upsert: typeof indexUpsert;
  prune: typeof indexPrune;
}

export const defaultScanOps: ScanIndexOps = {
  refs: indexRefs,
  upsert: indexUpsert,
  prune: indexPrune,
};

/**
 * One incremental scan pass ([F8] browser): per agent, diff the plugin's
 * stat-level `list()` against the index by (ref, mtime, size), open ONLY the
 * new/changed sessions (`describe` + `content`), upsert, then prune refs
 * that vanished from the store. A failing agent logs and skips — one broken
 * store must not hide the other three.
 */
export async function scanAgentHistories(
  sources: HistorySource[],
  ops: ScanIndexOps = defaultScanOps,
  /** Fires after every landed batch — lets the browser refresh its listing
   * while a long first-ever scan is still filling the index. */
  onProgress?: () => void,
): Promise<void> {
  for (const { agentId, history } of sources) {
    try {
      const stubs = await history.list();
      const stored = new Map(
        (await ops.refs(agentId)).map((r) => [r.reference, r]),
      );
      const changed = stubs.filter((stub) => {
        const seen = stored.get(stub.ref);
        return !seen || seen.mtime !== stub.mtime || seen.size !== stub.size;
      });
      for (let at = 0; at < changed.length; at += BATCH) {
        const batch = changed.slice(at, at + BATCH);
        const rows = await Promise.all(
          batch.map(async (stub): Promise<IndexRowInput | null> => {
            try {
              const facts = await history.describe(stub.ref);
              const content = await history.content(stub.ref);
              return {
                sessionId: stub.sessionId,
                reference: stub.ref,
                cwd: facts.cwd,
                title: facts.title ?? null,
                transcriptPath: facts.transcriptPath ?? null,
                mtime: stub.mtime,
                size: stub.size,
                content: content.slice(0, CONTENT_CAP),
              };
            } catch (e) {
              log.warn(
                "web:history",
                `${agentId} ${stub.sessionId}: skipped — ${describeError(e)}`,
              );
              return null;
            }
          }),
        );
        const usable = rows.filter((row): row is IndexRowInput => row !== null);
        if (usable.length > 0) {
          await ops.upsert(agentId, usable);
          onProgress?.();
        }
      }
      // An empty listing over a NON-empty index is ambiguous: every agent's
      // `list()` degrades a read failure (permissions, a detached volume, a
      // moved store) to [], which reads exactly like "the CLI deleted every
      // session". Pruning on that would wipe the agent's whole history from
      // the browser until a full re-scan rebuilds it session by session.
      // Skip — a real store this size going to zero is rare enough that one
      // stale listing until the next scan is the cheaper wrong answer.
      if (stubs.length === 0 && stored.size > 0) {
        log.warn(
          "web:history",
          `${agentId}: empty listing over ${stored.size} indexed sessions — prune skipped (unreadable store?)`,
        );
        continue;
      }
      const dropped = await ops.prune(
        agentId,
        stubs.map((stub) => stub.ref),
      );
      if (dropped > 0) onProgress?.();
    } catch (e) {
      log.warn(
        "web:history",
        `${agentId} history scan failed: ${describeError(e)}`,
      );
    }
  }
}
