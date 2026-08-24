import { describe, expect, it, vi } from "vitest";
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

/** Paths whose read came back SHORT, mapped to the file's full length — the
 * double could not express falling short at all before this: `truncated` was
 * hard-coded false and `readBytes` was missing outright, hidden by the cast to
 * `PluginContext`. */
type ShortReads = Record<string, number>;

function ctx(
  files: Record<string, string>,
  dirs: Record<string, unknown[]>,
  warn: (message: string) => void = vi.fn(),
  short: ShortReads = {},
) {
  return {
    log: { warn, info: vi.fn(), error: vi.fn() },
    services: {
      fs: {
        readDir: async (path: string) => {
          const entries = dirs[path];
          if (!entries) throw new Error("no dir");
          return entries;
        },
        readFile: async (path: string) => {
          if (!(path in files)) throw new Error("no file");
          const text = files[path];
          const full = short[path];
          // BYTES, not characters. kimi's fixtures are Russian, so the two
          // differ by roughly double here — and the assertion would compare
          // the same wrong number to itself and stay green.
          const readBytes = new TextEncoder().encode(text).length;
          return {
            path,
            text,
            isBinary: false,
            size: full ?? readBytes,
            readBytes,
            truncated: full !== undefined,
          };
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

  it("an unreadable working-dir folder fails the list; a session without agents/main is skipped", async () => {
    // Failure ≠ absence. An unreadable wd folder must throw (a partial list
    // prunes the index), while a session dir that simply never spawned an
    // agent has no agents/main and is legitimately skipped.
    const broken = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        // "/k/wd_a_1" deliberately absent → readDir throws.
      }),
    );
    await expect(broken.list()).rejects.toThrow();

    const bare = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [{ name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir" }],
        // no agents/main for session_s1 — created, never spawned.
      }),
    );
    expect(await bare.list()).toEqual([]);
  });

  it("listing() walks past an unreadable working-dir folder: what read is indexed, the folder is named, the answer is incomplete", async () => {
    const warn = vi.fn();
    const history = kimiHistory(
      ctx(
        {},
        {
          "~/.kimi-code/sessions": [
            { name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" },
            { name: "wd_b_2", path: "/k/wd_b_2", kind: "dir" },
          ],
          "/k/wd_a_1": [
            { name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir" },
          ],
          "/k/wd_a_1/session_s1/agents/main": [
            { name: "wire.jsonl", path: "/k/wd_a_1/session_s1/agents/main/wire.jsonl", kind: "file", size: 4, mtime: 9 },
          ],
          // "/k/wd_b_2" deliberately absent → readDir throws.
        },
        warn,
      ),
    );
    expect(await history.listing!()).toEqual({
      stubs: [
        { sessionId: "session_s1", ref: "/k/wd_a_1/session_s1/agents/main/wire.jsonl", mtime: 9, size: 4 },
      ],
      complete: false,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("/k/wd_b_2");
  });

  it("a session without agents/main is a normal shape under listing() too — skipped, walk still complete", async () => {
    // The prune hazard's honest half: never-spawned sessions drop out of a
    // COMPLETE listing. Only an agents/main that exists but won't read is
    // the hazard — and the fs layer cannot tell those apart (see the
    // named comment at the catch in history.ts).
    const history = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [{ name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir" }],
      }),
    );
    expect(await history.listing!()).toEqual({ stubs: [], complete: true });
  });

  it("listing() on an unreadable root answers nothing-read and incomplete — never an empty store", async () => {
    const warn = vi.fn();
    const history = kimiHistory(ctx({}, {}, warn));
    expect(await history.listing!()).toEqual({ stubs: [], complete: false });
    expect(warn).toHaveBeenCalledTimes(1);
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

  it("a page cut short by the cap says so in bytes", async () => {
    // kimi is the store where a cut can land INSIDE an emitted turn: its
    // parser accumulates fragments across lines, so the tail turn is short and
    // looks whole. That specific loss is unprovable from the held bytes, so
    // the honest claim is the one this page makes — the reading fell short,
    // and there may be more beyond it.
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const history = kimiHistory(ctx({ [wire]: WIRE }, {}, vi.fn(), { [wire]: 9_000_000 }));
    const page = await history.transcriptPage!(wire, { offset: 0, limit: 10 });
    expect(page.shortfall).toEqual([
      {
        kind: "bytes",
        size: 9_000_000,
        readBytes: new TextEncoder().encode(WIRE).length,
      },
    ]);
  });

  it("a page that read everything carries no shortfall at all", async () => {
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const history = kimiHistory(ctx({ [wire]: WIRE }, {}));
    const page = await history.transcriptPage!(wire, { offset: 0, limit: 10 });
    expect(page.shortfall).toBeUndefined();
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
