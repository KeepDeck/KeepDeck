import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The SessionStart reporter now forwards an optional transcript_path (the
 * codex usage tailer's input) — exercise the real script on both payload
 * shapes. The claude and codex copies are byte-identical by design; testing
 * one covers both (the sync itself is a review-time invariant).
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/kd-session-hook.sh",
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

function run(dir: string, stdin: string): void {
  const env = { ...process.env };
  env.KEEPDECK_BRIDGE = JSON.stringify({ v: 1, dir, pane: "pane-3", token: "tok" });
  execFileSync("/bin/sh", [SCRIPT], { input: stdin, env });
}

function envelope(dir: string): Record<string, unknown> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
}

describe("kd-session-hook.sh", () => {
  it("forwards the transcript path when the hook payload carries one", () => {
    const dir = inbox();
    run(
      dir,
      JSON.stringify({
        session_id: "sid-1",
        transcript_path: "/x/sessions/rollout-1.jsonl",
      }),
    );
    expect(envelope(dir)).toEqual({
      v: 1,
      type: "session.bound",
      paneId: "pane-3",
      token: "tok",
      payload: {
        sessionId: "sid-1",
        transcriptPath: "/x/sessions/rollout-1.jsonl",
      },
    });
  });

  it("binds without a transcript path exactly as before", () => {
    const dir = inbox();
    run(dir, JSON.stringify({ session_id: "sid-1" }));
    expect(envelope(dir)).toEqual({
      v: 1,
      type: "session.bound",
      paneId: "pane-3",
      token: "tok",
      payload: { sessionId: "sid-1" },
    });
  });
});
