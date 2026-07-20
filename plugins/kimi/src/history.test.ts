import { describe, expect, it } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { kimiHistory, parseWire } from "./history";

// Shapes mirror a REAL kimi 0.27 wire: the user opens turns in
// append_message and interjects mid-turn via turn.steer (origin.kind
// "user"); the assistant streams as append_loop_event/content.part, ONE
// part per step with step/tool events between them (it NEVER appears as an
// append_message — the old fixture invented that shape and hid a parser
// that dropped every assistant turn). turn.steer ALSO delivers
// background-task notifications — origin.kind tells them apart.
const WIRE = [
  JSON.stringify({ type: "metadata", protocol_version: "1.4" }),
  JSON.stringify({
    type: "context.append_message",
    message: { role: "user", content: [{ type: "text", text: "проверь тесты" }] },
  }),
  JSON.stringify({ type: "step.begin" }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "запускаю тесты" } },
  }),
  JSON.stringify({ type: "tool.call", tool: "bash" }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "все зелёные" } },
  }),
  JSON.stringify({
    type: "turn.steer",
    input: [{ type: "text", text: "и линтер прогони" }],
    origin: { kind: "user" },
    time: 1784318704583,
  }),
  JSON.stringify({
    type: "turn.steer",
    input: [{ type: "text", text: '<notification id="task:bash-1:completed">done</notification>' }],
    origin: { kind: "background_task", taskId: "bash-1" },
    time: 1784318704600,
  }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "линтер чист" } },
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

  it("per-step assistant fragments join with a newline, split by user speech", () => {
    const turns = parseWire(WIRE);
    expect(turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    // Distinct steps (a tool ran between them) — never glued run-on.
    expect(turns[1].text).toBe("запускаю тесты\nвсе зелёные");
    expect(turns[3].text).toBe("линтер чист");
  });

  it("a user turn.steer is a real mid-turn user message; a background-task one is noise", () => {
    const turns = parseWire(WIRE);
    expect(turns[2]).toEqual({ role: "user", text: "и линтер прогони" });
    // The notification steer (origin background_task) appears nowhere.
    expect(turns.some((t) => t.text.includes("notification"))).toBe(false);
  });
});
