import { describe, expect, it, vi } from "vitest";
import { createSessionStore, type PluginContext } from "@keepdeck/plugin-api";
import { fsStore } from "@keepdeck/plugin-api/testing";
import { kimiHistory } from "./history";

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
    message: { role: "user", content: [{ type: "text", text: "check the tests" }] },
  }),
  JSON.stringify({ type: "step.begin" }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "running the tests" } },
  }),
  JSON.stringify({ type: "tool.call", tool: "bash" }),
  JSON.stringify({
    type: "context.append_loop_event",
    event: { type: "content.part", part: { type: "text", text: "all green" } },
  }),
  JSON.stringify({
    type: "turn.steer",
    input: [{ type: "text", text: "run the linter too" }],
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
    event: { type: "content.part", part: { type: "text", text: "linter is clean" } },
  }),
  JSON.stringify({
    type: "context.append_message",
    message: { role: "user", content: [{ type: "text", text: "thanks" }] },
  }),
].join("\n");

const STATE = JSON.stringify({
  title: "test run",
  workDir: "/repo/wt",
  agents: { main: { homedir: "/x" } },
});

function ctx(
  files: Record<string, string>,
  dirs: Record<string, unknown[]>,
  warn: (message: string) => void = vi.fn(),
) {
  // A wire is read a WINDOW at a time now, so the double has to serve
  // windows. It also refuses a missing path by throwing, which is kimi's own
  // shape — the other two answer with null text; only the ANSWER is shared,
  // how a store refuses is the store's business.
  const fs = fsStore(files);
  return {
    log: { warn, info: vi.fn(), error: vi.fn() },
    services: {
      fs: {
        readDir: async (path: string) => {
          const entries = dirs[path];
          if (!entries) throw new Error("no dir");
          return entries;
        },
        readFile: fs.readFile,
      },
      sessionStore: createSessionStore(fs),
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
        // agents/ reads and holds no `main` — created, never spawned. The
        // parent has to READ for this to be provably absence rather than
        // a refusal, which is the whole distinction this walk now makes.
        "/k/wd_a_1/session_s1/agents": [],
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

  /**
   * The routine shapes, and there are two of them. Both must leave the walk
   * COMPLETE, or pruning turns itself off for good: a store full of
   * never-spawned sessions would mark every pass incomplete and the index
   * would keep deleted sessions forever.
   */
  it("a session that never spawned keeps the walk complete — whether agents/ is empty or absent", async () => {
    const spawnedNothing = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [{ name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir" }],
        // agents/ reads and holds no `main` — spawned nothing yet.
        "/k/wd_a_1/session_s1/agents": [],
      }),
    );
    expect(await spawnedNothing.listing!()).toEqual({ stubs: [], complete: true });

    const noAgentsAtAll = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [{ name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir" }],
        // The session dir reads and has no `agents` child at all — the
        // shape a session takes before any agent directory exists. The
        // probe of the session dir is the ONLY thing that tells this from
        // an `agents/` that refuses to open.
        "/k/wd_a_1/session_s1": [
          { name: "state.json", path: "/k/wd_a_1/session_s1/state.json", kind: "file" },
        ],
      }),
    );
    expect(await noAgentsAtAll.listing!()).toEqual({ stubs: [], complete: true });
  });

  it("a session whose agents/main exists but will not read keeps its stub, is named, and the listing is incomplete", async () => {
    const warn = vi.fn();
    const history = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [
          { name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir", mtime: 5 },
          { name: "session_s2", path: "/k/wd_a_1/session_s2", kind: "dir", mtime: 7 },
        ],
        "/k/wd_a_1/session_s1/agents/main": [
          { name: "wire.jsonl", path: "/k/wd_a_1/session_s1/agents/main/wire.jsonl", kind: "file", size: 4, mtime: 9 },
        ],
        // s2's agents/main will not read, but its parent SHOWS that it exists.
        "/k/wd_a_1/session_s2/agents": [
          { name: "main", path: "/k/wd_a_1/session_s2/agents/main", kind: "dir" },
        ],
      }, warn),
    );
    expect(await history.listing!()).toEqual({
      stubs: [
        { sessionId: "session_s1", ref: "/k/wd_a_1/session_s1/agents/main/wire.jsonl", mtime: 9, size: 4 },
        // A stub of EXISTENCE. Its fingerprint cannot equal a real wire's:
        // the store never writes size 0 for a wire that has been messaged.
        { sessionId: "session_s2", ref: "/k/wd_a_1/session_s2/agents/main/wire.jsonl", mtime: 7, size: 0 },
      ],
      complete: false,
    });
    expect(String(warn.mock.calls[0][0])).toContain("session_s2");
  });

  it("a session dir that will not read is incomplete too — unknowable is never 'no session'", async () => {
    const warn = vi.fn();
    const history = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [{ name: "session_s1", path: "/k/wd_a_1/session_s1", kind: "dir" }],
        // Neither agents/main, nor agents, nor the session dir will read.
      }, warn),
    );
    const out = await history.listing!();
    expect(out.stubs).toEqual([
      { sessionId: "session_s1", ref: "/k/wd_a_1/session_s1/agents/main/wire.jsonl", mtime: 0, size: 0 },
    ]);
    expect(out.complete).toBe(false);
    expect(String(warn.mock.calls[0][0])).toContain("session_s1");
  });

  it("list() refuses a session it cannot honestly describe — and the no-store arm does not swallow the refusal", async () => {
    const history = kimiHistory(
      ctx({}, {
        "~/.kimi-code/sessions": [{ name: "wd_a_1", path: "/k/wd_a_1", kind: "dir" }],
        "/k/wd_a_1": [{ name: "session_s2", path: "/k/wd_a_1/session_s2", kind: "dir" }],
        "/k/wd_a_1/session_s2/agents": [
          { name: "main", path: "/k/wd_a_1/session_s2/agents/main", kind: "dir" },
        ],
      }),
    );
    await expect(history.list()).rejects.toThrow(/session_s2/);
    // The "no store" arm still answers [] — the refusal lives outside it.
    expect(await kimiHistory(ctx({}, {})).list()).toEqual([]);
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

  it("describe reads the directory under the NEWER key too", async () => {
    // Sessions written since kimi 0.38 carry `cwd` where older ones carried
    // `workDir`. Reading only the old name left every recent session
    // unattached to its folder in the browser — 22 of 88 on a real store.
    const newer = JSON.stringify({ cwd: "/repo/fresh", title: "recent run" });
    const history = kimiHistory(
      ctx({ "/k/wd_a_1/session_s1/state.json": newer }, {}),
    );

    expect(
      await history.describe("/k/wd_a_1/session_s1/agents/main/wire.jsonl"),
    ).toMatchObject({ cwd: "/repo/fresh", title: "recent run" });
  });

  it("describe still answers with no directory when the state names none", async () => {
    // The eight oldest sessions on a real store carry neither key. An empty
    // cwd is the honest answer; inventing one would attach a session to a
    // folder it was never in.
    const history = kimiHistory(
      ctx(
        { "/k/wd_a_1/session_s1/state.json": JSON.stringify({ title: "old" }) },
        {},
      ),
    );

    expect(
      await history.describe("/k/wd_a_1/session_s1/agents/main/wire.jsonl"),
    ).toMatchObject({ cwd: "", title: "old" });
  });

  it("indexes a role the dialect does not recognize, as the transcript shows it", async () => {
    // The index used to drop these while the transcript kept them: two
    // answers about one conversation. One behaviour now, and it is the
    // keeping one — an unfamiliar role carrying real text is likelier to be
    // conversation we failed to name than noise.
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const odd = JSON.stringify({
      type: "context.append_message",
      message: { role: "moderator", content: [{ type: "text", text: "held" }] },
    });
    const history = kimiHistory(ctx({ [wire]: odd }, {}));

    const page = await history.transcript(wire, { offset: 0, limit: 10 });
    expect(page).toEqual([{ role: "other", text: "held" }]);
    expect(await history.content(wire)).toContain("held");
  });

  it("a page cut short by the budget says so in bytes", async () => {
    // kimi is the store where a cut can land INSIDE an emitted turn: the
    // dialect accumulates fragments across lines, so the tail turn is short
    // and looks whole. That specific loss is unprovable from the held bytes,
    // so the honest claim is the one this page makes — the reading fell
    // short, and there may be more beyond it.
    //
    // The fixture has to be genuinely bigger than one read may pass through:
    // a double that merely CLAIMED a large file would describe a world where
    // the bytes between what it returned and what it claimed do not exist.
    const line = JSON.stringify({
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "x".repeat(2000) }] },
    });
    const big = `${line}\n`.repeat(4500);
    const size = new TextEncoder().encode(big).length;
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const history = kimiHistory(ctx({ [wire]: big }, {}));

    const page = await history.transcriptPage!(wire, { offset: 4400, limit: 10 });

    expect(page.entries.length).toBeLessThan(10);
    expect(page.shortfall).toHaveLength(1);
    const [mark] = page.shortfall!;
    expect(mark).toMatchObject({ kind: "bytes", size });
    expect((mark as { readBytes: number }).readBytes).toBeLessThan(size);
  });

  it("a page that read everything carries no shortfall at all", async () => {
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const history = kimiHistory(ctx({ [wire]: WIRE }, {}));
    const page = await history.transcriptPage!(wire, { offset: 0, limit: 10 });
    expect(page.shortfall).toBeUndefined();
  });

  it("per-step assistant fragments join with a newline, split by user speech", async () => {
    // Through the contract rather than through an exported parser: what the
    // dialect means is only observable in what a reading returns.
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const history = kimiHistory(ctx({ [wire]: WIRE }, {}));
    const turns = await history.transcript(wire, { offset: 0, limit: 20 });
    expect(turns.map((t) => t.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    // Distinct steps (a tool ran between them) — never glued run-on.
    expect(turns[1].text).toBe("running the tests\nall green");
    expect(turns[3].text).toBe("linter is clean");
  });

  it("a user turn.steer is a real mid-turn user message; a background-task one is noise", async () => {
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const history = kimiHistory(ctx({ [wire]: WIRE }, {}));
    const turns = await history.transcript(wire, { offset: 0, limit: 20 });
    expect(turns[2]).toEqual({ role: "user", text: "run the linter too" });
    // The notification steer (origin background_task) appears nowhere.
    expect(turns.some((t) => t.text.includes("notification"))).toBe(false);
  });

  /**
   * The turn boundary the format writes for itself.
   *
   * These fixtures are SYNTHETIC on purpose and the reason is worth keeping:
   * no session in the real store puts two answers back to back across a
   * `turn.ended` — a user message always intervenes (0 such cases in 121
   * records). So the wire below is a shape the store has not produced yet,
   * and the reading is correct for it rather than correct by accident.
   */
  const line = (record: unknown) => JSON.stringify(record);
  const userSaid = (text: string) =>
    line({
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text }] },
    });
  const fragment = (text: string) =>
    line({
      type: "context.append_loop_event",
      event: { type: "content.part", part: { type: "text", text } },
    });
  const ended = (reason: string) =>
    line({ type: "turn.ended", turnId: 0, reason, durationMs: 10, time: 1 });
  const readTurns = async (lines: string[]) => {
    const wire = "/k/wd_a_1/session_s1/agents/main/wire.jsonl";
    const history = kimiHistory(ctx({ [wire]: lines.join("\n") + "\n" }, {}));
    return history.transcript(wire, { offset: 0, limit: 20 });
  };

  it("turn.ended closes the held answer — two in a row stay two turns", async () => {
    expect(
      await readTurns([
        userSaid("question"),
        fragment("answer one"),
        ended("completed"),
        fragment("answer two"),
        ended("completed"),
      ]),
    ).toEqual([
      { role: "user", text: "question" },
      { role: "assistant", text: "answer one" },
      { role: "assistant", text: "answer two" },
    ]);
  });

  it("every reason closes the turn — a cancelled answer is still an answer", async () => {
    // completed 100, cancelled 18, failed 3 on the real store. A cancelled
    // or failed answer is what the assistant said before it stopped, and
    // folding it into the next turn would misattribute it.
    const turns = await readTurns([
      userSaid("q"),
      fragment("interrupted"),
      ended("cancelled"),
      fragment("failed"),
      ended("failed"),
    ]);
    expect(turns.map((t) => t.text)).toEqual(["q", "interrupted", "failed"]);
  });

  it("turn.ended over an empty buffer adds no turn of its own", async () => {
    // 13 of the 121 arrive this way. The record is a boundary, not speech.
    expect(
      await readTurns([
        userSaid("question"),
        fragment("answer"),
        ended("completed"),
        ended("completed"),
        userSaid("more"),
      ]),
    ).toEqual([
      { role: "user", text: "question" },
      { role: "assistant", text: "answer" },
      { role: "user", text: "more" },
    ]);
  });

  it("a last answer with no turn.ended still arrives — the fallback holds", async () => {
    // Older CLIs wrote no such record, and a live session's newest turn has
    // not ended yet. `end` is what closes those.
    expect(await readTurns([userSaid("q"), fragment("last answer")])).toEqual([
      { role: "user", text: "q" },
      { role: "assistant", text: "last answer" },
    ]);
  });
});
