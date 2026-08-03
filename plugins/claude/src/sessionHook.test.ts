import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The SessionStart reporter, exercised as the real script on the payload
 * shapes claude and codex produce. It is authored once under
 * resources/reporters/ and shipped into each plugin; this runs the canonical
 * file, and scripts/reporterScripts.test.mjs is what pins the shipped copies
 * to it. kimi's own branch (transcript through its session index) is covered
 * against kimi's shipped copy in plugins/kimi/src/reporter.test.ts.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../resources/reporters/kd-session-hook.sh",
);

const dirs: string[] = [];
function inbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "kd-hook-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stdin comes from a FILE, never execFileSync's `input` pipe. The script
 * checks its preconditions and exits BEFORE it reads stdin, while `input:`
 * writes only AFTER the spawn — so a guard that exits first closes the read
 * end under the writer and the HARNESS fails with EPIPE although the hook
 * itself succeeded. Same reason and same shape as statusHook.test.ts.
 */
function run(dir: string, stdin: string, args: string[] = ["claude"]): void {
  const env = { ...process.env };
  env.KEEPDECK_BRIDGE = JSON.stringify({ v: 1, dir, pane: "pane-3", token: "tok" });
  const file = join(inbox(), "payload.json");
  writeFileSync(file, stdin);
  const fd = openSync(file, "r");
  try {
    execFileSync("/bin/sh", [SCRIPT, ...args], {
      stdio: [fd, "pipe", "pipe"],
      env,
    });
  } finally {
    closeSync(fd);
  }
}

/**
 * The published envelope with the reporting process split off: its value is a
 * live process group, so it is asserted for SHAPE here once and by identity
 * in the dedicated case below, and the payload assertions stay exact.
 */
function envelope(dir: string): {
  envelope: Record<string, unknown>;
  reporter: unknown;
} {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  const parsed = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
  const { reporter, ...payload } = parsed.payload as Record<string, unknown>;
  return { envelope: { ...parsed, payload }, reporter };
}

describe("kd-session-hook.sh", () => {
  it("names the reporting agent and why the session started", () => {
    const dir = inbox();
    run(
      dir,
      JSON.stringify({
        session_id: "sid-1",
        transcript_path: "/x/sessions/rollout-1.jsonl",
        source: "startup",
      }),
    );
    const published = envelope(dir);
    expect(published.envelope).toEqual({
      v: 1,
      type: "session.bound",
      paneId: "pane-3",
      token: "tok",
      payload: {
        agent: "claude",
        sessionId: "sid-1",
        transcriptPath: "/x/sessions/rollout-1.jsonl",
        source: "startup",
      },
    });
    // The reporting process, as a bare process-group number.
    expect(published.reporter).toMatch(/^\d+$/);
  });

  it("names the same process on every invocation of one agent", () => {
    // The deck pins a pane's generation to this value and refuses anything
    // else, so a value that drifted between two events of the SAME agent
    // would refuse the pane's own rebinds. Two runs under one parent shell
    // stand in for two hook events of one agent process.
    const dir = inbox();
    const second = inbox();
    run(dir, JSON.stringify({ session_id: "sid-1" }));
    run(second, JSON.stringify({ session_id: "sid-2" }));
    expect(envelope(dir).reporter).toBe(envelope(second).reporter);
  });

  it("binds with neither a transcript path nor a source", () => {
    const dir = inbox();
    run(dir, JSON.stringify({ session_id: "sid-1" }));
    expect(envelope(dir).envelope).toEqual({
      v: 1,
      type: "session.bound",
      paneId: "pane-3",
      token: "tok",
      payload: { agent: "claude", sessionId: "sid-1" },
    });
  });

  it("drops a JSON-hostile transcript path rather than the whole binding", () => {
    // A quote in a path component would corrupt the printf'd envelope and
    // cost the pane its identity — the guard falls back to a bare bind.
    const dir = inbox();
    run(
      dir,
      JSON.stringify({
        session_id: "sid-1",
        transcript_path: '/Users/me/pro"j/rollout.jsonl',
      }),
    );
    expect(envelope(dir).envelope.payload).toEqual({
      agent: "claude",
      sessionId: "sid-1",
    });
  });

  it("drops a source that would break the envelope, and only that", () => {
    const dir = inbox();
    run(dir, JSON.stringify({ session_id: "sid-1", source: 'star"tup' }));
    expect(envelope(dir).envelope.payload).toEqual({
      agent: "claude",
      sessionId: "sid-1",
    });
  });

  it("keeps a source carrying digits, dashes or colons", () => {
    // The guard must not NARROW: a dropped source reads as a fresh start, and
    // a fresh start is the case the deck refuses — so over-tight filtering
    // costs a legitimate rebind rather than preventing anything.
    const dir = inbox();
    run(dir, JSON.stringify({ session_id: "sid-1", source: "auto-compact:2" }));
    expect(envelope(dir).envelope.payload).toMatchObject({ source: "auto-compact:2" });
  });

  it("takes the FIRST source, not a later one nested in the payload", () => {
    // Hook payloads are compact single-line JSON, so a line-oriented `head`
    // is no protection against sed's greedy match. The direction matters: an
    // inner "resume" overriding a real "startup" turns a fresh session into a
    // continuation, which is the one verdict that overwrites the pane.
    const dir = inbox();
    run(
      dir,
      JSON.stringify({
        session_id: "sid-1",
        source: "startup",
        tool_input: { source: "resume" },
      }),
    );
    expect(envelope(dir).envelope.payload).toMatchObject({ source: "startup" });
  });

  it("publishes nothing when the session id would break the envelope", () => {
    // The id has no bare fallback: a quote closes the JSON string mid-value
    // and the bridge drops the envelope unread. Saying nothing reaches the
    // same place without leaving garbage in the inbox.
    const dir = inbox();
    run(dir, JSON.stringify({ session_id: 'ab"cd' }));
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });

  it("publishes nothing when the arming site forgot the agent argument", () => {
    // An unattributed binding is one the deck would have to refuse anyway;
    // saying nothing keeps the pane on the binding it already has.
    const dir = inbox();
    run(dir, JSON.stringify({ session_id: "sid-1" }), []);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
  });
});
