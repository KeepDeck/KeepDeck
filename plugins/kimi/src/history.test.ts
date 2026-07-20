import { describe, expect, it } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { kimiHistory, parseWire } from "./history";

// Shapes mirror a REAL kimi 0.27 wire: the user speaks in append_message;
// the assistant streams as append_loop_event/content.part fragments (it
// NEVER appears as an append_message — the old fixture invented that shape
// and hid a parser that dropped every assistant turn).
const WIRE = [
  JSON.stringify({ type: "metadata", protocol_version: "1.4" }),
  JSON.stringify({
    type: "context.append_message",
    message: { role: "user", content: [{ type: "text", text: "проверь тесты" }] },
  }),
  JSON.stringify({ type: "tool.call", tool: "bash" }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "все " } },
  }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "зелёные" } },
  }),
  JSON.stringify({
    type: "context.append_message",
    message: { role: "user", content: [{ type: "text", text: "спасибо" }] },
  }),
].join("\n");

const STATE = JSON.stringify({
  title: "test run",
  workDir: "/repo/wt",
  agents: { main: { homedir: "/x" } },
});

function ctx(files: Record<string, string>, dirs: Record<string, unknown[]>) {
  return {
    services: {
      fs: {
        readDir: async (path: string) => {
          const entries = dirs[path];
          if (!entries) throw new Error("no dir");
          return entries;
        },
        readFile: async (path: string) => {
          if (!(path in files)) throw new Error("no file");
          return { path, text: files[path], isBinary: false, size: 0, truncated: false };
        },
      },
    },
  } as unknown as PluginContext;
}

describe("kimi history", () => {
  it("lists sessions by their wire file (the change fingerprint)", async () => {
    const history = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [{ name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir" }],
        "/k/wd_a_1/session_s1/agents/main": [
          { name: "wire.jsonl", path: "/k/wd_a_1/session_s1/agents/main/wire.jsonl", kind: "file", size: 4, mtime: 9 },
        ],
      }),
    );
    expect(await history.list()).toEqual([
      { sessionId: "session_s1", ref: "/k/wd_a_1/session_s1/agents/main/wire.jsonl", mtime: 9, size: 4 },
    ]);
  });

  it("describe reads workDir + title from the sibling state.json", async () => {
    const history = kimiHistory(
      ctx({ "/k/wd_a_1/session_s1/state.json": STATE }, {}),
    );
    expect(
      await history.describe("/k/wd_a_1/session_s1/agents/main/wire.jsonl"),
    ).toEqual({
      cwd: "/repo/wt",
      title: "test run",
      transcriptPath: "/k/wd_a_1/session_s1/agents/main/wire.jsonl",
    });
  });

  it("assistant fragments concatenate into one turn between user messages", () => {
    const turns = parseWire(WIRE);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[1].text).toBe("все зелёные");
  });
});
