import {
  firstMeaningfulUserTurn,
  textFromParts,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginContext,
} from "@keepdeck/plugin-api";

/**
 * Discovery over codex's store ([F8] browser): date-partitioned rollouts at
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`; the first
 * line's `session_meta` payload carries the id and cwd. Read-only via `fs`.
 */
const ROOT = "~/.codex/sessions";

interface ParsedTurn {
  role: "user" | "assistant";
  text: string;
}

/** Rollout lines: `response_item` payloads of type `message` with a content
 * array of `input_text`/`output_text` parts. Developer/meta roles are
 * plumbing, not conversation. */
export function parseRollout(jsonl: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = parsed as {
      type?: unknown;
      payload?: { type?: unknown; role?: unknown; content?: unknown };
    };
    if (record.type !== "response_item") continue;
    const payload = record.payload;
    if (payload?.type !== "message") continue;
    if (payload.role !== "user" && payload.role !== "assistant") continue;
    const text = textFromParts(payload.content).trim();
    if (text) turns.push({ role: payload.role, text });
  }
  return turns;
}

export function titleOf(turns: ParsedTurn[]): string | undefined {
  return firstMeaningfulUserTurn(turns);
}

const FILE_UUID = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;

export function codexHistory(ctx: PluginContext): AgentHistory {
  const walk = async (path: string): Promise<AgentSessionStub[]> => {
    const out: AgentSessionStub[] = [];
    const entries = await ctx.services.fs.readDir(path).catch(() => []);
    for (const entry of entries) {
      if (entry.kind === "dir") {
        out.push(...(await walk(entry.path)));
        continue;
      }
      const match = entry.kind === "file" ? FILE_UUID.exec(entry.name) : null;
      if (!match) continue;
      out.push({
        sessionId: match[1],
        ref: entry.path,
        mtime: entry.mtime ?? 0,
        size: entry.size ?? 0,
      });
    }
    return out;
  };
  return {
    async list() {
      try {
        await ctx.services.fs.readDir(ROOT);
      } catch {
        return [];
      }
      return walk(ROOT);
    },
    async describe(ref) {
      const head = await ctx.services.fs.readFile(ref, { maxBytes: 256 * 1024 });
      const text = head.text ?? "";
      const newline = text.indexOf("\n");
      // No newline in the head = one giant meta line; take the whole head
      // rather than slice(0,-1)'s silent last-char drop.
      const first = newline < 0 ? text : text.slice(0, newline);
      let cwd = "";
      try {
        const meta = JSON.parse(first) as {
          type?: unknown;
          payload?: { cwd?: unknown };
        };
        if (meta.type === "session_meta" && typeof meta.payload?.cwd === "string") {
          cwd = meta.payload.cwd;
        }
      } catch {
        // No meta line — an unexpected layout indexes with an empty cwd.
      }
      return { cwd, title: titleOf(parseRollout(text)), transcriptPath: ref };
    },
    async content(ref) {
      const file = await ctx.services.fs.readFile(ref, { maxBytes: 8 * 1024 * 1024 });
      return parseRollout(file.text ?? "")
        .map((t) => t.text)
        .join("\n");
    },
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      const file = await ctx.services.fs.readFile(ref, { maxBytes: 8 * 1024 * 1024 });
      return parseRollout(file.text ?? "")
        .slice(page.offset, page.offset + page.limit)
        .map((t) => ({ role: t.role, text: t.text }));
    },
  };
}
