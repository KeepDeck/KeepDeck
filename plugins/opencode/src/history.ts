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

  /** One page of turns WITH what the reading fell short by.
   *
   * A part row that will not PARSE is a real loss and countable right here —
   * no extra query, no total to know: the text of a shown turn simply has a
   * hole in it, and a hole inside a visible turn is the one shortfall a
   * reader would otherwise blame on the agent.
   *
   * Only the parse failure counts. `partText` answers `null` for three very
   * different reasons — torn JSON, a part with no text to give (a tool call,
   * a thinking step), and an empty string — and the last two are the store
   * working normally. Counting all three would report thousands of "lost"
   * parts for a tool-heavy session that lost nothing: a mark that cries on
   * healthy data is worse than no mark, because it teaches the reader to
   * ignore it. A row whose data is SQL NULL is not counted either — an empty
   * envelope is not a damaged one.
   *
   * The row cap is the OTHER loss and is deliberately not claimed yet: this
   * read can see that the cap bit but not how much it hid, and a measure it
   * cannot fill would be a worse lie than the silence. It arrives with the
   * partition count. */
  const readPage = async (
    ref: string,
    page: { offset: number; limit: number },
  ) => {
    const messages = await query(
      "SELECT id, data FROM message WHERE session_id = ?1 ORDER BY time_created",
      [ref],
    );
    const parts = await query(
      "SELECT message_id, data FROM part WHERE session_id = ?1 ORDER BY id LIMIT 20000",
      [ref],
    );
    const byMessage = new Map<string, string[]>();
    let unreadableParts = 0;
    for (const [messageId, data] of parts) {
      if (!messageId || !data) continue;
      // The parse is done HERE, not read off `partText`'s answer, because
      // only this position can tell a torn row from a part that simply has
      // no text. `partText` still decides what counts as text — the two
      // answer different questions about the same row.
      try {
        JSON.parse(data);
      } catch {
        unreadableParts += 1;
        continue;
      }
      const text = partText(data);
      if (text === null) continue;
      const list = byMessage.get(messageId) ?? [];
      list.push(text);
      byMessage.set(messageId, list);
    }
    const all: AgentTranscriptEntry[] = [];
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
      all.push({ role, text: texts.join("\n") });
    }
    const entries = all.slice(page.offset, page.offset + page.limit);
    return {
      entries,
      ...(unreadableParts > 0
        ? { shortfall: [{ kind: "parts" as const, unreadableParts }] }
        : {}),
    };
  };

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
      // Ordered explicitly: an unordered LIMIT happens to follow id order
      // today, but that's an artifact, not a guarantee — and real sessions
      // already exceed 5k parts, so the cap must drop the TAIL, not a hole.
      // `id`, not time_created: real sessions share ONE timestamp across
      // thousands of parts, so ids (client-minted, sortable) are the only
      // chronological key. One known store quirk rides along harmlessly: a
      // synthetic `prt_0000000000_thinking` sentinel sorts before its
      // session's first real part, but its type ("thinking") never yields
      // text, so partText drops it.
      const rows = await query(
        "SELECT data FROM part WHERE session_id = ?1 ORDER BY id LIMIT 20000",
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
    // ONE reading, two contracts — the same pair every other agent offers.
    // A store-backed plugin measures in its own units, not the file-backed
    // ones: there are no bytes here to fall short of.
    transcriptPage: readPage,
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      return (await readPage(ref, page)).entries;
    },
  };
}
