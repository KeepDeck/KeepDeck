import type {
  AgentHistory,
  AgentSessionStub,
  AgentTranscriptEntry,
  PluginContext,
} from "@keepdeck/plugin-api";

/**
 * Discovery over opencode's store ([F8] browser): everything lives in one
 * SQLite database — `session` rows carry directory/title/time_updated,
 * `part` rows carry the message content as JSON. Read via the
 * `sqliteReadonly` capability (a binary blob is useless to `fs`); the query
 * text lives HERE because the schema knowledge is this plugin's.
 */
const DB = "~/.local/share/opencode/opencode.db";

/** A part row's text, when it is a text part. */
export function partText(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { type?: unknown; text?: unknown };
    if (parsed.type === "text" && typeof parsed.text === "string") {
      const text = parsed.text.trim();
      return text === "" ? null : text;
    }
  } catch {
    // Foreign/torn part rows never sink the session.
  }
  return null;
}

export function opencodeHistory(ctx: PluginContext): AgentHistory {
  const query = (sql: string, params: string[] = []) =>
    ctx.services.sqlite.query(DB, sql, params);
  return {
    async list(): Promise<AgentSessionStub[]> {
      let rows: (string | null)[][];
      try {
        rows = await query(
          "SELECT id, time_updated FROM session WHERE time_archived IS NULL",
        );
      } catch {
        return []; // no store — opencode never ran here
      }
      return rows.flatMap(([id, updated]) =>
        id
          ? [
              {
                sessionId: id,
                ref: id,
                mtime: Number(updated ?? 0),
                // The db has no per-session byte size; mtime alone is the
                // change fingerprint (time_updated moves on every write).
                size: 0,
              },
            ]
          : [],
      );
    },
    async describe(ref) {
      const rows = await query(
        "SELECT directory, title FROM session WHERE id = ?1",
        [ref],
      );
      const [directory, title] = rows[0] ?? [];
      return {
        cwd: directory ?? "",
        ...(title ? { title: title.slice(0, 120) } : {}),
      };
    },
    async content(ref) {
      // Bounded on both axes: a row cap (the largest real session holds
      // ~5k parts) and a text-accumulation cap — a monster session must not
      // drag tens of MB across the IPC bridge into the index.
      const rows = await query(
        "SELECT data FROM part WHERE session_id = ?1 LIMIT 5000",
        [ref],
      );
      const texts: string[] = [];
      let total = 0;
      for (const [data] of rows) {
        const text = data ? partText(data) : null;
        if (text === null) continue;
        texts.push(text);
        total += text.length;
        if (total >= 2 * 1024 * 1024) break;
      }
      return texts.join("\n");
    },
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      const messages = await query(
        "SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created",
        [ref],
      );
      const parts = await query(
        "SELECT message_id, data FROM part WHERE session_id = ?1 LIMIT 5000",
        [ref],
      );
      const byMessage = new Map<string, string[]>();
      for (const [messageId, data] of parts) {
        const text = data ? partText(data) : null;
        if (!messageId || text === null) continue;
        const list = byMessage.get(messageId) ?? [];
        list.push(text);
        byMessage.set(messageId, list);
      }
      const entries: AgentTranscriptEntry[] = [];
      for (const [id, data] of messages) {
        const texts = id ? byMessage.get(id) : undefined;
        if (!texts?.length) continue;
        let role: AgentTranscriptEntry["role"] = "other";
        try {
          const parsed = JSON.parse(data ?? "") as { role?: unknown };
          if (parsed.role === "user" || parsed.role === "assistant") {
            role = parsed.role;
          }
        } catch {
          // keep "other"
        }
        entries.push({ role, text: texts.join("\n") });
      }
      return entries.slice(page.offset, page.offset + page.limit);
    },
  };
}
