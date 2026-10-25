import { describe, expect, it } from "vitest";
import type { ForkPlanInput, PluginSqlite, ResumePlanInput } from "@keepdeck/plugin-api";
import { fakeOpencode, v1Session, v2Session } from "./fakeOpencode.test-support";
import { OPENCODE_SESSION_ENV, sessionOpening } from "./opening";

/**
 * Opening a recorded session — resumed or forked — behind the one check
 * both share: the store is asked where the session lives first, and a
 * session the pane's opencode would open as something else is refused
 * before anything runs (task-378, task-460).
 */
const ID = "ses_0db9e24cbffej1WlbsRKynAHf3";
const COPIED = 5000;

/** A store as the host's SQL answers it: which table sets it has, the copy's
 * marker, and the session's row in each set. */
function store(shape: {
  v1?: number;
  v2?: number;
  tables?: ("v1" | "v2")[];
  copy?: "completed" | "sessions";
}): PluginSqlite {
  const tables = shape.tables ?? ["v1", "v2"];
  const names = [
    ...(tables.includes("v1") ? ["session", "message", "part"] : []),
    ...(tables.includes("v2") ? ["session_v2", "session_message", "event_sequence", "kv"] : []),
  ];
  const answer = (rows: (string | null)[][]) => ({ rows, stopped: "exhausted" as const, payloadBytes: 0 });
  return {
    query: async (_db, sql) => {
      if (sql.includes("sqlite_master")) return answer(names.map((name) => [name]));
      if (sql.includes("FROM kv")) return answer([[shape.copy ?? "completed", String(COPIED)]]);
      if (sql.includes("FROM session_v2")) return answer(shape.v2 ? [[String(shape.v2)]] : []);
      if (sql.includes("FROM session ")) return answer(shape.v1 ? [[String(shape.v1)]] : []);
      throw new Error(`unexpected query ${sql}`);
    },
  };
}

const base = {
  paneId: "pane-3",
  workspace: { id: "ws-1", instance: "workspace-instance-1" },
  cwd: "/repo/target",
  sessionId: ID,
};
const resumeOn = (cliVersion?: string): ResumePlanInput => ({ ...base, ...(cliVersion ? { cliVersion } : {}) });
const forkOn = (cliVersion?: string): ForkPlanInput => ({ ...resumeOn(cliVersion), sourceCwd: "/repo/source" });

describe("resuming", () => {
  it("opens a session the pane's opencode has — 2.x naming it in the environment too", async () => {
    const v2 = sessionOpening(fakeOpencode({ generation: 2, sqlite: store({ v2: 7000 }) }).ports);
    expect(await v2.resume(resumeOn("2.1.4"))).toEqual({
      args: ["-s", ID],
      env: [[OPENCODE_SESSION_ENV, ID]],
    });
    const v1 = sessionOpening(fakeOpencode({ generation: 1, sqlite: store({ v1: 6100 }) }).ports);
    expect(await v1.resume(resumeOn("1.19.3"))).toEqual(["-s", ID]);
  });

  it("refuses on 2.x what 2.x would open as an empty session — or later wipe", async () => {
    const refusedOn = (shape: Parameters<typeof store>[0]) =>
      sessionOpening(fakeOpencode({ generation: 2, sqlite: store(shape) }).ports).resume(resumeOn("2.1.4"));
    await expect(refusedOn({ v1: 6100 })).rejects.toThrow("recorded by opencode 1.x");
    await expect(refusedOn({ v1: 1000, copy: "sessions" })).rejects.toThrow("has not copied this 1.x conversation");
    await expect(refusedOn({ v1: 9000, v2: 7000 })).rejects.toThrow("continued in opencode 1.x");
    // In neither set: 2.x would make it up rather than say so.
    await expect(refusedOn({})).rejects.toThrow(`opencode 2.1.4 has no session ${ID}.`);
  });

  it("refuses on 1.x a session 2.x has gone on with — and leaves one in neither set to 1.x, which says so itself", async () => {
    const on = (shape: Parameters<typeof store>[0]) =>
      sessionOpening(fakeOpencode({ generation: 1, sqlite: store(shape) }).ports).resume(resumeOn("1.19.3"));
    await expect(on({ v1: 1000, v2: 7000 })).rejects.toThrow("continued in opencode 2.x");
    await expect(on({ v2: 8100 })).rejects.toThrow("recorded by opencode 2.x");
    await expect(on({})).resolves.toEqual(["-s", ID]);
  });

  it("leaves the answer to opencode when the store cannot be read, and says so in the log", async () => {
    const fake = fakeOpencode({ generation: 2 });
    await expect(sessionOpening(fake.ports).resume(resumeOn("2.1.4"))).resolves.toMatchObject({ args: ["-s", ID] });
    expect(fake.warns.join("\n")).toContain("no opencode store");
  });

  it("checks an unknown version as 1.x — the generation it is launched as", async () => {
    const opening = sessionOpening(fakeOpencode({ generation: 1, sqlite: store({ v2: 8100 }) }).ports);
    await expect(opening.resume(resumeOn())).rejects.toThrow("but this pane runs opencode 1.x");
  });
});

describe("forking", () => {
  it("copies the session into the pane's directory and opens the clone by its own id", async () => {
    const fake = fakeOpencode({
      generation: 2,
      sessions: { [ID]: v2Session(ID, "/repo/source") },
      sqlite: store({ v2: 7000 }),
    });
    const args = await sessionOpening(fake.ports).fork(forkOn("2.1.4"));
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("-s");
    expect(args[1]).not.toBe(ID);
    expect(args).not.toContain("--fork");
    expect(fake.runs[0]?.args).toEqual(["session", "export", ID, "--standalone"]);
  });

  it("refuses another generation's session before anything runs", async () => {
    const fake = fakeOpencode({ generation: 2, sqlite: store({ v1: 6100 }) });
    await expect(sessionOpening(fake.ports).fork(forkOn("2.1.4"))).rejects.toThrow("recorded by opencode 1.x");
    expect(fake.runs).toEqual([]);
  });

  it("refuses a session 2.x went on with on a 1.x pane — its export would be the stale half", async () => {
    const fake = fakeOpencode({
      generation: 1,
      sessions: { [ID]: v1Session(ID, "/repo/source") },
      sqlite: store({ v1: 1000, v2: 7000 }),
    });
    await expect(sessionOpening(fake.ports).fork(forkOn("1.19.3"))).rejects.toThrow("continued in opencode 2.x");
    expect(fake.runs).toEqual([]);
  });

  it("lets the export decide a session in neither set — and words its refusal for this opencode", async () => {
    const fake = fakeOpencode({ generation: 1, sqlite: store({}) });
    await expect(sessionOpening(fake.ports).fork(forkOn("1.19.3"))).rejects.toThrow(
      `opencode 1.19.3 has no session ${ID}.`,
    );
    expect(fake.runs.map((run) => run.args[0])).toEqual(["export"]);
  });

  it("forks with the 1.x recipe when the version is unknown", async () => {
    const fake = fakeOpencode({ generation: 1, sessions: { [ID]: v1Session(ID, "/repo/source") } });
    const args = await sessionOpening(fake.ports).fork(forkOn());
    expect(args[0]).toBe("-s");
    expect(fake.runs.map((run) => run.args[0])).toEqual(["export", "import", "export"]);
  });
});
