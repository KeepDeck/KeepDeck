import {
  textFromParts,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type PluginContext,
} from "@keepdeck/plugin-api";

/**
 * Discovery over kimi's store ([F8] browser): sessions live at
 * `~/.kimi-code/sessions/wd_<key>/session_<id>/` — `state.json` carries
 * workDir + title, `agents/main/wire.jsonl` is the conversation. The wire
 * file is the change fingerprint (a dir's mtime doesn't move when a child
 * file grows). Read-only via `fs`.
 */
const ROOT = "~/.kimi-code/sessions";

interface ParsedTurn {
  role: "user" | "assistant" | "other";
  text: string;
}

/** Wire lines carry the TWO halves of a conversation in different shapes
 * (verified against a real kimi 0.27 store):
 * - the USER's messages are whole `context.append_message` events with a
 *   text-part content array;
 * - the ASSISTANT's text streams as `context.append_loop_event` events of
 *   inner type `content.part`, one fragment each — NEVER as append_message.
 * Contiguous assistant fragments concatenate into one turn, flushed when a
 * user message (or the file's end) arrives. Tool calls/thinking/usage are
 * not conversation text. */
export function parseWire(jsonl: string): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  let assistant: string[] = [];
  const flushAssistant = () => {
    const text = assistant.join("").trim();
    assistant = [];
    if (text) turns.push({ role: "assistant", text });
  };
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
      message?: { role?: unknown; content?: unknown };
      event?: { type?: unknown; part?: { type?: unknown; text?: unknown } };
    };
    if (record.type === "context.append_loop_event") {
      const part = record.event?.type === "content.part" ? record.event.part : null;
      if (part?.type === "text" && typeof part.text === "string") {
        assistant.push(part.text);
      }
      continue;
    }
    if (record.type !== "context.append_message") continue;
    flushAssistant();
    const role = record.message?.role;
    const text = textFromParts(record.message?.content).trim();
    if (!text) continue;
    turns.push({
      role: role === "user" ? "user" : role === "assistant" ? "assistant" : "other",
      text,
    });
  }
  flushAssistant();
  return turns;
}

const WIRE_SUFFIX = "/agents/main/wire.jsonl";

export function kimiHistory(ctx: PluginContext): AgentHistory {
  return {
    async list(): Promise<AgentSessionStub[]> {
      const stubs: AgentSessionStub[] = [];
      let wdDirs;
      try {
        wdDirs = await ctx.services.fs.readDir(ROOT);
      } catch {
        return [];
      }
      for (const wd of wdDirs) {
        if (wd.kind !== "dir" || !wd.name.startsWith("wd_")) continue;
        const sessions = await ctx.services.fs.readDir(wd.path).catch(() => []);
        for (const session of sessions) {
          if (session.kind !== "dir" || !session.name.startsWith("session_")) continue;
          const main = await ctx.services.fs
            .readDir(`${session.path}/agents/main`)
            .catch(() => []);
          const wire = main.find((f) => f.name === "wire.jsonl");
          if (!wire) continue; // never messaged — nothing to index
          stubs.push({
            sessionId: session.name,
            ref: wire.path,
            mtime: wire.mtime ?? 0,
            size: wire.size ?? 0,
          });
        }
      }
      return stubs;
    },
    async describe(ref) {
      const sessionDir = ref.endsWith(WIRE_SUFFIX)
        ? ref.slice(0, -WIRE_SUFFIX.length)
        : ref;
      const state = await ctx.services.fs
        .readFile(`${sessionDir}/state.json`)
        .catch(() => null);
      try {
        const parsed = JSON.parse(state?.text ?? "") as {
          workDir?: unknown;
          title?: unknown;
        };
        return {
          cwd: typeof parsed.workDir === "string" ? parsed.workDir : "",
          ...(typeof parsed.title === "string" &&
            parsed.title !== "" && { title: parsed.title.slice(0, 120) }),
          transcriptPath: ref,
        };
      } catch {
        return { cwd: "", transcriptPath: ref };
      }
    },
    async content(ref) {
      const file = await ctx.services.fs.readFile(ref, { maxBytes: 8 * 1024 * 1024 });
      return parseWire(file.text ?? "")
        .filter((t) => t.role !== "other")
        .map((t) => t.text)
        .join("\n");
    },
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      const file = await ctx.services.fs.readFile(ref, { maxBytes: 8 * 1024 * 1024 });
      return parseWire(file.text ?? "")
        .slice(page.offset, page.offset + page.limit)
        .map((t) => ({ role: t.role, text: t.text }));
    },
  };
}
