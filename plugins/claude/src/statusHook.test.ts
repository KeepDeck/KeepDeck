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

/** The environment a KeepDeck-spawned claude hands the hook. */
function bridged(dir: string): Record<string, string | undefined> {
  return {
    ...process.env,
    KEEPDECK_BRIDGE: JSON.stringify({ v: 1, dir, pane: "pane-3", token: "tok" }),
  };
}

/**
 * Stdin comes from a FILE, never execFileSync's `input` pipe. The script
 * checks its preconditions and exits BEFORE it reads stdin, while `input:`
 * writes only AFTER the spawn — so a guard that exits first closes the read
 * end under the writer, and the HARNESS fails with EPIPE although the hook
 * itself succeeded (`status: 0` in the error is the tell). Who wins is pure
 * scheduling: macOS /bin/sh is bash and needs milliseconds to start, so the
 * writer never lost locally, while Linux CI's dash reaches `exit 0` in under
 * one and a loaded runner flaked. A file has no writer to break. Same reason,
 * same shape as plugins/kimi/src/reporter.test.ts, which was bitten first.
 */
function hook(
  args: string[],
  env: Record<string, string | undefined>,
  stdin: string,
): void {
  // Its own dir, reaped here: the inbox is asserted file by file, and a stray
  // payload sitting there would read as a published envelope.
  const dir = mkdtempSync(join(tmpdir(), "kd-status-hook-stdin-"));
  try {
    const payload = join(dir, "payload");
    writeFileSync(payload, stdin);
    const fd = openSync(payload, "r");
    try {
      execFileSync("/bin/sh", [SCRIPT, ...args], {
        stdio: [fd, "pipe", "pipe"],
        env,
      });
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir: string, stdin: string, agent = "claude"): void {
  hook([agent], bridged(dir), stdin);
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
    // Bigger than any pipe buffer (64K on Linux). Both guards below exit
    // before reading stdin, so on an `input:` pipe the writer would break and
    // this test would fail on EVERY machine — instead of only on a loaded CI
    // runner, where the race hid until it finally fired.
    const waiting = `{"a":"${"x".repeat(200_000)}"}`;
    // No agent argument.
    hook([], bridged(dir), waiting);
    // Empty stdin.
    run(dir, "");
    // No bridge var at all.
    const unarmed = bridged(dir);
    delete unarmed.KEEPDECK_BRIDGE;
    hook(["claude"], unarmed, waiting);
    expect(readdirSync(dir)).toHaveLength(0);
  });
});
