import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The status reporter, EXECUTED — the byte-identity test in
 * scripts/reporterScripts.test.mjs pins the three copies to each other,
 * but only running one proves the envelope, the oversize degradation and
 * the staging discipline actually work in a shell. The copies are
 * byte-identical by design; testing one covers all three.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/kd-status-hook.sh",
);

const dirs: string[] = [];
function inbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "kd-status-hook-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(dir: string, stdin: string, agent = "claude"): void {
  const env = { ...process.env };
  env.KEEPDECK_BRIDGE = JSON.stringify({ v: 1, dir, pane: "pane-3", token: "tok" });
  execFileSync("/bin/sh", [SCRIPT, agent], { input: stdin, env });
}

function envelope(dir: string): Record<string, unknown> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
}

describe("kd-status-hook.sh", () => {
  it("wraps the hook payload verbatim under the agent's envelope", () => {
    const dir = inbox();
    run(dir, JSON.stringify({ hook_event_name: "Stop", extra: "kept" }));
    expect(envelope(dir)).toEqual({
      v: 1,
      type: "agent.status",
      paneId: "pane-3",
      token: "tok",
      payload: {
        agent: "claude",
        event: { hook_event_name: "Stop", extra: "kept" },
      },
    });
    // No staging file survives a successful publish.
    expect(
      readdirSync(dir).filter((f) => !f.endsWith(".json")),
    ).toHaveLength(0);
  });

  it("degrades an oversized payload to the bare event name, measured in BYTES", () => {
    const dir = inbox();
    // ~70k CYRILLIC characters ≈ 140KB in UTF-8: over the byte cap while a
    // character count would wave it through.
    const monster = JSON.stringify({
      hook_event_name: "Stop",
      last_assistant_message: "ж".repeat(70_000),
    });
    run(dir, monster);
    expect(envelope(dir)).toMatchObject({
      type: "agent.status",
      payload: { agent: "claude", event: { hook_event_name: "Stop" } },
    });
  });

  it("stays silent and writes nothing without bridge context, agent or stdin", () => {
    const dir = inbox();
    // No agent argument.
    const env = { ...process.env };
    env.KEEPDECK_BRIDGE = JSON.stringify({ v: 1, dir, pane: "p", token: "t" });
    execFileSync("/bin/sh", [SCRIPT], { input: "{}", env });
    // Empty stdin.
    run(dir, "");
    // No bridge var at all.
    delete env.KEEPDECK_BRIDGE;
    execFileSync("/bin/sh", [SCRIPT, "claude"], { input: "{}", env });
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
