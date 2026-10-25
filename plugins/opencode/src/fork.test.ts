import { describe, expect, it, vi } from "vitest";
import type { CommandRun } from "./exec";
import {
  fakeOpencode,
  v1Session,
  v2Session,
  V1_ERROR,
  type FakeOpencodeOptions,
  type FakeRun,
} from "./fakeOpencode.test-support";
import { forkInto, type ForkRequest } from "./fork";
import { recipeV1, recipeV2 } from "./forkRecipe";

/**
 * The fork's core over a fake opencode of each generation: the order of the
 * steps, where each runs, and that every failure is a refusal in words —
 * never a fork somewhere else.
 */
const SRC = "ses_0db9e24cbffej1WlbsRKynAHf3";
const TARGET = "/repo/target";
const SCRATCH = "/tmp/keepdeck-opencode/fork-pane-7.json";

const request: ForkRequest = {
  paneId: "pane-7",
  cwd: TARGET,
  sessionId: SRC,
  missing: "opencode 1.19.3 has no session.",
};

const v1 = (options: Partial<FakeOpencodeOptions> = {}) =>
  fakeOpencode({ generation: 1, sessions: { [SRC]: v1Session(SRC, "/repo/source") }, ...options });
const v2 = (options: Partial<FakeOpencodeOptions> = {}) =>
  fakeOpencode({ generation: 2, sessions: { [SRC]: v2Session(SRC, "/repo/source") }, ...options });

/** The verb of a run: `export`/`import` on 1.x, `session export`/… on 2.x. */
const verb = (run: FakeRun) => run.args.find((arg) => arg === "export" || arg === "import");
/** A read-back is an export of the clone, not of the source. */
const isReadBack = (run: FakeRun) => verb(run) === "export" && !run.args.includes(SRC);

const ok = (text: string): CommandRun => ({ text, code: 0 });

describe("a 1.x fork", () => {
  it("exports, imports and reads the clone back, all FROM the target, and answers the clone's id", async () => {
    const fake = v1();
    const id = await forkInto(fake.ports, recipeV1, request);

    expect(id).not.toBe(SRC);
    expect(fake.runs).toEqual([
      { args: ["export", SRC], cwd: TARGET },
      // 1.x records the directory the import runs IN.
      { args: ["import", SCRATCH], cwd: TARGET },
      { args: ["export", id], cwd: TARGET },
    ]);
  });

  it("lands a clone whose answers name the clone's own turns — not the source's", async () => {
    const fake = v1();
    const id = await forkInto(fake.ports, recipeV1, request);
    const landed = fake.sessions.get(id);
    expect(landed).toMatchObject({ info: { id, directory: TARGET } });
    const json = JSON.stringify(landed);
    for (const message of v1Session(SRC, "").messages) expect(json).not.toContain(message.info.id);
    // The source is as it was.
    expect(fake.sessions.get(SRC)).toEqual(v1Session(SRC, "/repo/source"));
  });

  it("removes the scratch — it held the whole conversation — on success and on failure", async () => {
    const fine = v1();
    await forkInto(fine.ports, recipeV1, request);
    expect(fine.removed).toEqual([SCRATCH]);
    expect(fine.files.size).toBe(0);

    const broken = v1({ answer: (run) => (verb(run) === "import" ? { text: "boom\r\n", code: 1 } : undefined) });
    await expect(forkInto(broken.ports, recipeV1, request)).rejects.toThrow("The copy failed");
    expect(broken.removed).toEqual([SCRATCH]);
  });

  it("refuses a session this opencode does not have, in the words it was given — and imports nothing", async () => {
    const fake = fakeOpencode({ generation: 1 });
    await expect(forkInto(fake.ports, recipeV1, request)).rejects.toThrow(request.missing);
    expect(fake.runs.map(verb)).toEqual(["export"]);
  });

  it("refuses a target that does not exist — it never forks elsewhere", async () => {
    const fake = v1({ exists: () => false });
    await expect(forkInto(fake.ports, recipeV1, request)).rejects.toThrow(
      `The fork target ${TARGET} does not exist.`,
    );
    expect(fake.runs).toEqual([]);
  });

  it("refuses an export that is not a 1.x session, before anything is written", async () => {
    const fake = v1({ answer: (run) => (verb(run) === "export" ? ok("nothing here\r\n") : undefined) });
    await expect(forkInto(fake.ports, recipeV1, request)).rejects.toThrow("The copy failed");
    expect(fake.files.size).toBe(0);
    expect(fake.runs.map(verb)).toEqual(["export"]);
  });

  it("does not take the import's word for it: a claimed import whose clone is empty is refused", async () => {
    // Measured on 1.19.3: an import that kept the source's message ids exits
    // 0, says `Imported session: <new>`, and the clone has no messages.
    const fake = v1({
      answer: (run) =>
        isReadBack(run)
          ? ok(`Exporting session: x\r\n${JSON.stringify({ ...v1Session(run.args[1] ?? "", TARGET), messages: [] })}`)
          : undefined,
    });
    await expect(forkInto(fake.ports, recipeV1, request)).rejects.toThrow(/The copy failed: the clone lost message/);
  });

  it("refuses a clone that landed in another directory", async () => {
    const fake = v1({
      answer: (run) =>
        isReadBack(run) ? ok(JSON.stringify(v1Session(run.args[1] ?? "", "/repo/source"))) : undefined,
    });
    await expect(forkInto(fake.ports, recipeV1, request)).rejects.toThrow(
      `the clone landed in /repo/source, not ${TARGET}`,
    );
  });

  it("refuses a clone whose answer still names the source's turn", async () => {
    const fake = v1({
      answer: (run) => {
        if (!isReadBack(run)) return undefined;
        const landed = fake.sessions.get(run.args[1] ?? "");
        const copy = JSON.parse(JSON.stringify(landed));
        copy.messages[1].info.parentID = "msg_f2461db4d001rzij8gRRPwcFG1";
        return ok(JSON.stringify(copy));
      },
    });
    await expect(forkInto(fake.ports, recipeV1, request)).rejects.toThrow("answers another turn");
  });

  it("accepts a clone that left out an answer that never finished", async () => {
    // Export and import carry what was written whole; the unfinished tail is
    // the one thing a clone may lack.
    const source = v1Session(SRC, "/repo/source");
    const unfinished = structuredClone(source.messages[1]);
    unfinished.info.id = "msg_f2461db5b001uNFINISHEDtail0";
    unfinished.info.time = { created: 1792899000400, completed: 0 };
    unfinished.parts = [];
    const withTail = { ...source, messages: [...source.messages, unfinished] };
    const fake = fakeOpencode({
      generation: 1,
      sessions: { [SRC]: withTail },
      answer: (run) => {
        if (!isReadBack(run)) return undefined;
        const landed = JSON.parse(JSON.stringify(fake.sessions.get(run.args[1] ?? "")));
        landed.messages = landed.messages.slice(0, 2);
        return ok(JSON.stringify(landed));
      },
    });
    await expect(forkInto(fake.ports, recipeV1, request)).resolves.toMatch(/^ses_/);
  });

  it("reads back once more when the store was locked — and refuses when it stays locked", async () => {
    // Measured on 1.19.3: an export right after the import answered
    // `database is locked`, and a second one read the clone.
    const locked = { text: `${V1_ERROR}Unexpected error\r\n\r\ndatabase is locked\r\n`, code: 1 };
    let lockedOnce = false;
    const once = v1({
      answer: (run) => {
        if (!isReadBack(run) || lockedOnce) return undefined;
        lockedOnce = true;
        return locked;
      },
    });
    await expect(forkInto(once.ports, recipeV1, request)).resolves.toMatch(/^ses_/);
    expect(once.runs.filter(isReadBack)).toHaveLength(2);

    const always = v1({ answer: (run) => (isReadBack(run) ? locked : undefined) });
    await expect(forkInto(always.ports, recipeV1, request)).rejects.toThrow("could not be read back");
    expect(always.runs.filter(isReadBack)).toHaveLength(2);
  });

  it("refuses an import that did not name the clone", async () => {
    const fake = v1({ answer: (run) => (verb(run) === "import" ? ok("done\r\n") : undefined) });
    await expect(forkInto(fake.ports, recipeV1, request)).rejects.toThrow("did not import");
  });
});

describe("a 2.x fork", () => {
  it("runs 2.x's session commands, with its own server, from the target — and believes the exact success line", async () => {
    const fake = v2();
    const id = await forkInto(fake.ports, recipeV2, { ...request, missing: "gone" });

    expect(id).not.toBe(SRC);
    expect(fake.runs).toEqual([
      { args: ["session", "export", SRC, "--standalone"], cwd: TARGET },
      {
        args: ["session", "import", SCRATCH, "--directory", TARGET, "--standalone"],
        cwd: TARGET,
      },
    ]);
    expect(fake.sessions.get(id)).toMatchObject({ info: { id, location: { directory: TARGET } } });
    expect(fake.removed).toEqual([SCRATCH]);
  });

  it("refuses a collision: 2.x exits 0 and says `Session already exists`", async () => {
    const fake = v2({
      answer: (run) => (verb(run) === "import" ? ok("Session already exists\r\n") : undefined),
    });
    await expect(forkInto(fake.ports, recipeV2, request)).rejects.toThrow("already exists");
  });

  it("refuses an import that exited 0 without its success line", async () => {
    const fake = v2({ answer: (run) => (verb(run) === "import" ? ok("") : undefined) });
    await expect(forkInto(fake.ports, recipeV2, request)).rejects.toThrow("did not import");
  });

  it("refuses a session 2.x does not have, and a 1.x document from its export", async () => {
    const missing = fakeOpencode({ generation: 2 });
    await expect(forkInto(missing.ports, recipeV2, request)).rejects.toThrow(request.missing);

    const wrong = v2({
      answer: (run) => (verb(run) === "export" ? ok(JSON.stringify(v1Session(SRC, "/x"))) : undefined),
    });
    await expect(forkInto(wrong.ports, recipeV2, request)).rejects.toThrow("not print a 2.x session");
  });
});

describe("a command that never exits", () => {
  it("is killed after the timeout, and the fork refused", async () => {
    vi.useFakeTimers();
    try {
      const fake = v1({ hang: (run) => verb(run) === "export" });
      const forking = forkInto(fake.ports, recipeV1, request);
      forking.catch(() => {});
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(forking).rejects.toThrow(/The copy failed: opencode export .* timed out/);
      expect(fake.kills.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an import that hangs is killed BEFORE the scratch it reads is removed", async () => {
    vi.useFakeTimers();
    try {
      const fake = v1({ hang: (run) => verb(run) === "import" });
      const forking = forkInto(fake.ports, recipeV1, request);
      forking.catch(() => {});
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(forking).rejects.toThrow(/The copy failed: opencode import .* timed out/);
      expect(fake.kills.count).toBeGreaterThanOrEqual(1);
      expect(fake.removed).toEqual([SCRATCH]);
    } finally {
      vi.useRealTimers();
    }
  });
});
