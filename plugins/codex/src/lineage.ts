/**
 * A codex conversation stored in more than one file (task-588).
 *
 * Since codex 0.163 a fork of a paginated thread — `codex fork <id>`, which
 * is how KeepDeck forks, and the TUI's /fork — no longer copies its source's
 * history. Its opening `session_meta` points back instead: `history_base`
 * names the source rollout and the byte its inherited prefix ends at, and
 * the source may point further back the same way (thread-store
 * rollout_lineage.rs). Read alone, a fork's file is only what was said
 * after the fork.
 */
import { isJsonRecord, jsonl, type JsonlRequest, type PluginLogger, type PluginSessionStore } from "@keepdeck/plugin-api";

/** What a fork inherited: its source rollout, and the byte — a line
 * boundary in the source's plain text — where the inherited prefix ends. */
export interface HistoryBase {
  rolloutId: string;
  endByte: number;
}

/** The `history_base` a rollout's `session_meta` record names, or null —
 * for any other record, and for a session that inherited nothing. */
export function historyBaseOf(record: unknown): HistoryBase | null {
  if (!isJsonRecord(record) || record.type !== "session_meta" || !isJsonRecord(record.payload)) return null;
  const base = record.payload.history_base;
  if (!isJsonRecord(base)) return null;
  const { thread_id: rolloutId, end_byte_offset: endByte } = base;
  return typeof rolloutId === "string" && typeof endByte === "number" && Number.isSafeInteger(endByte) && endByte >= 0
    ? { rolloutId, endByte }
    : null;
}

export interface LineagePorts {
  sessionStore: PluginSessionStore;
  /** The file a rollout id names, or null. */
  find(rolloutId: string): Promise<string | null>;
  log: PluginLogger;
}

/** The base the rollout at `path` opens with, read from its first record. */
async function baseAt(store: PluginSessionStore, path: string): Promise<HistoryBase | null> {
  let base: HistoryBase | null = null;
  await store.read(
    jsonl(isJsonRecord),
    { path },
    (record) => {
      base = historyBaseOf(record);
      return "enough";
    },
    "head",
  );
  return base;
}

/**
 * The parts of the conversation the rollout at `ref` belongs to, oldest
 * first: each source's inherited prefix, then `ref` itself. `base` is what
 * `ref` itself opens with, already read.
 *
 * A source that is not on disk ends the chain there, as does one seen
 * before — `ref` itself included, by its own rollout id, as codex's
 * resolver counts the start: what is left is still the conversation, from
 * that point on.
 */
export async function lineageOf(
  ports: LineagePorts,
  ref: string,
  base: HistoryBase,
  rolloutId?: string,
): Promise<JsonlRequest[]> {
  const parts: JsonlRequest[] = [{ path: ref }];
  const seen = new Set<string>(rolloutId === undefined ? [] : [rolloutId]);
  for (let next: HistoryBase | null = base; next !== null; ) {
    if (seen.has(next.rolloutId)) {
      ports.log.warn(`codex: ${ref} inherits from ${next.rolloutId} twice — read from there on`);
      break;
    }
    seen.add(next.rolloutId);
    const source = await ports.find(next.rolloutId);
    if (source === null) {
      ports.log.warn(`codex: ${ref} inherits from ${next.rolloutId}, which is not on disk — read from there on`);
      break;
    }
    parts.unshift({ path: source, until: next.endByte });
    next = await baseAt(ports.sessionStore, source);
  }
  return parts;
}
