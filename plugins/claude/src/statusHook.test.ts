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
import { normalizeClaudeStatus } from "./status";

/**
 * The status reporter, EXECUTED — scripts/reporterScripts.test.mjs pins every
 * shipped copy to the canonical file under resources/reporters/, but only
 * running one proves the envelope, the oversize degradation and the staging
 * discipline actually work in a shell. Running the shipped copy rather than
 * the canonical one is deliberate: it is what a spawned CLI opens.
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
    // A UTF-8 ambient locale, ALWAYS — the script overrides it, and that
    // override is what the invalid-byte case below proves. Inheriting the
    // runner's locale instead would make that proof environment-dependent: on
    // a CI container with LC_ALL unset the ambient locale is already C, the
    // override becomes a no-op, and the test would pass with it deleted.
    LC_ALL: "en_US.UTF-8",
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
  // A Buffer too: one case feeds a byte no UTF-8 locale accepts, which a
  // string cannot carry.
  stdin: string | Buffer,
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

function run(dir: string, stdin: string | Buffer, agent = "claude"): void {
  hook([agent], bridged(dir), stdin);
}

/** A payload guaranteed to trip the reduction, in the shape that actually
 * drives it in the field: a huge final assistant message. */
function oversized(event: Record<string, unknown>): string {
  return JSON.stringify({ ...event, last_assistant_message: "ж".repeat(140_000) });
}

/** The published envelope as the normalizer receives it — so a reduction can
 * be judged by the EDGE it produces, not by its serialized shape. */
function envelopeEvent(dir: string): unknown {
  return (envelope(dir) as { payload: unknown }).payload;
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

  it("reduces only past the bridge's own limit, measured in BYTES", () => {
    // Under the cap the payload rides whole. The guard used to fire at half
    // the size that needs it, reducing payloads the bridge would have
    // delivered intact and widening every lossy failure below.
    const whole = inbox();
    run(
      whole,
      JSON.stringify({
        hook_event_name: "Stop",
        last_assistant_message: "ж".repeat(70_000),
      }),
    );
    expect(JSON.stringify(envelope(whole))).toContain("last_assistant_message");

    // Past it, the reduced shape. CYRILLIC is 2 bytes a character, so a
    // character count would wave this through.
    const cut = inbox();
    run(cut, oversized({ hook_event_name: "Stop" }));
    // EXACT, not a subset: the event name is all a reduction may carry, and
    // a partial match would let a field creep back in unnoticed — which is
    // how the value-copying and the invented task entry both shipped.
    expect(envelope(cut)).toEqual({
      v: 1,
      type: "agent.status",
      paneId: "pane-3",
      token: "tok",
      payload: { agent: "claude", event: { hook_event_name: "Stop" } },
    });
  });

  it("a reduced payload stays parseable whatever the values held", () => {
    // The reduction copies NO value out, so nothing it emits can be broken
    // by what a value contained. `"[^"]*"` would stop at the backslash of an
    // escaped quote and close the envelope mid-string, and the bridge drops
    // a malformed envelope WHOLE — losing the edge entirely. Only the event
    // name survives, and only because its charset is constrained to [A-Za-z].
    const dir = inbox();
    run(
      dir,
      oversized({
        hook_event_name: "StopFailure",
        error: 'say "hi" now',
        tool_response: { structuredContent: { detail: 'nested "quoted" text\\' } },
      }),
    );
    expect(envelope(dir)).toMatchObject({
      payload: { agent: "claude", event: { hook_event_name: "StopFailure" } },
    });
    // The error CLASS goes with every other value — a deliberate
    // degradation: the badge reads "Turn failed" instead of naming the rate
    // limit. Degraded is recoverable; a dropped envelope is not.
    expect(normalizeClaudeStatus(envelopeEvent(dir), 100)).toEqual({
      kind: "turn-failed",
      at: 100,
      error: "unknown",
    });
  });

  it("survives a byte no UTF-8 locale would accept", () => {
    // `tr` ABORTS at the first invalid byte under a UTF-8 locale and
    // truncates its output. The bad byte here sits BEFORE the event name —
    // claude's payload leads with paths, and a path is bytes, not text — so
    // a truncating `tr` would take the name with it and the whole envelope
    // would be dropped. Under LC_ALL=C a payload is bytes and it survives.
    const dir = inbox();
    const pad = Buffer.from("ж".repeat(140_000), "utf8");
    run(
      dir,
      Buffer.concat([
        Buffer.from('{"cwd":"/tmp/'),
        Buffer.from([0xff]),
        Buffer.from('","hook_event_name":"Stop","last_assistant_message":"'),
        pad,
        Buffer.from('"}'),
      ]),
    );
    expect(envelope(dir)).toMatchObject({
      payload: { event: { hook_event_name: "Stop" } },
    });
  });

  it("finds the event name however the payload is formatted", () => {
    // grep and sed are line-oriented; JSON's structural whitespace is not.
    const dir = inbox();
    run(
      dir,
      JSON.stringify(
        { hook_event_name: "Stop", last_assistant_message: "ж".repeat(140_000) },
        null,
        2,
      ),
    );
    expect(envelope(dir)).toMatchObject({
      payload: { event: { hook_event_name: "Stop" } },
    });
  });

  it("reads the payload's OWN event name, not a NESTED one", () => {
    // A tool result is arbitrary JSON, and structured output nests real
    // objects — whose keys are NOT escaped and so do match the anchors.
    // A greedy match took the LAST one, turning a mid-turn PostToolUse into
    // a Stop: a false "finished" banner over a running turn. The real key
    // leads in every schema we arm, so the FIRST match is the payload's own.
    const dir = inbox();
    run(
      dir,
      oversized({
        hook_event_name: "PostToolUse",
        tool_response: {
          structuredContent: {
            hook_event_name: "Stop",
            background_tasks: [{ id: "nested" }],
          },
        },
      }),
    );
    expect(envelope(dir)).toMatchObject({
      payload: { event: { hook_event_name: "PostToolUse" } },
    });
    expect(normalizeClaudeStatus(envelopeEvent(dir), 100)).toEqual({
      kind: "resumed",
      at: 100,
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
