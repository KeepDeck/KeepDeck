import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_PAYLOAD_KEYS, normalizeClaudeStatus } from "./status";

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

function run(
  dir: string,
  stdin: string,
  agent = "claude",
  // The REAL declaration, imported rather than restated: a copy here would
  // exercise the script against a list the arming site no longer sends.
  keys: readonly string[] = CLAUDE_PAYLOAD_KEYS,
): void {
  const env = { ...process.env };
  env.KEEPDECK_BRIDGE = JSON.stringify({ v: 1, dir, pane: "pane-3", token: "tok" });
  execFileSync("/bin/sh", [SCRIPT, agent, ...keys], { input: stdin, env });
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
    expect(envelope(cut)).toMatchObject({
      type: "agent.status",
      payload: { agent: "claude", event: { hook_event_name: "Stop" } },
    });
    // The reduction really happened — the prose is gone, not merely unread.
    expect(JSON.stringify(envelope(cut))).not.toContain("ж");
  });

  it("carries a declared key's non-emptiness beside the event, and parks on it", () => {
    // The oversize driver is the final assistant message, and it rides on
    // the very event whose list decides the edge. The fact travels as a
    // HOST-owned sibling of `event`: a reduction may take the CLI's fields
    // away, never invent one. Asserted through the normalizer, because the
    // edge is what the reduction exists to preserve.
    const dir = inbox();
    run(
      dir,
      oversized({
        hook_event_name: "Stop",
        background_tasks: [{ id: "a1", type: "subagent", status: "running" }],
      }),
    );
    expect(envelope(dir)).toMatchObject({
      payload: {
        agent: "claude",
        event: { hook_event_name: "Stop" },
        reduced: ["background_tasks"],
      },
    });
    expect(normalizeClaudeStatus(envelopeEvent(dir), 100)).toEqual({
      kind: "parked",
      at: 100,
    });
  });

  it("never copies a CLI value out, however the value is quoted", () => {
    // A captured string cannot be spliced back into JSON without an
    // escape-aware parser: `"[^"]*"` stops at the backslash of an escaped
    // quote, the envelope ends mid-string, and the bridge drops it WHOLE —
    // losing the very edge the reduction exists to save. So no value is
    // copied at all, and the payload stays parseable whatever it held.
    const dir = inbox();
    run(
      dir,
      oversized({ hook_event_name: "StopFailure", error: 'say "hi" now' }),
    );
    // Parseable, and the edge survives. The error CLASS is gone with every
    // other value — a deliberate degradation: the badge reads "Turn failed"
    // instead of "Rate limited", which is recoverable where dropped is not.
    expect(envelope(dir)).toMatchObject({
      payload: { event: { hook_event_name: "StopFailure" }, reduced: [] },
    });
    expect(normalizeClaudeStatus(envelopeEvent(dir), 100)).toEqual({
      kind: "turn-failed",
      at: 100,
      error: "unknown",
    });
  });

  it("finds a declared key however the payload is formatted", () => {
    // grep and sed are line-oriented; JSON's structural whitespace is not.
    // Pretty-printed, the flag used to vanish and the pane reported a turn
    // finished over live work — silently, in the unrecoverable direction.
    const dir = inbox();
    run(
      dir,
      JSON.stringify(
        {
          hook_event_name: "Stop",
          background_tasks: [{ id: "a1", status: "running" }],
          last_assistant_message: "ж".repeat(140_000),
        },
        null,
        2,
      ),
    );
    expect(envelope(dir)).toMatchObject({
      payload: { event: { hook_event_name: "Stop" }, reduced: ["background_tasks"] },
    });
  });

  it("invents no background work from an empty list, a CR, or quoted prose", () => {
    const pad = "ж".repeat(140_000);
    const cases: Record<string, string> = {
      empty: JSON.stringify({
        hook_event_name: "Stop",
        background_tasks: [],
        last_assistant_message: pad,
      }),
      // CR is JSON whitespace, so an empty list may legitimately carry one
      // between the brackets — it must not read as "something is in there".
      cr: `{"hook_event_name":"Stop","background_tasks":[\r],"pad":"${pad}"}`,
      // Prose QUOTING the key: inside a JSON string the quotes arrive
      // escaped, so the bare-quote anchor cannot match there.
      quoted: JSON.stringify({
        hook_event_name: "Stop",
        background_tasks: [],
        last_assistant_message:
          `I edited "background_tasks":[{"type":"subagent"}] here. ` + pad,
      }),
    };
    for (const [name, payload] of Object.entries(cases)) {
      const dir = inbox();
      run(dir, payload);
      expect(envelope(dir), name).toMatchObject({ payload: { reduced: [] } });
      // And the turn ends, rather than parking on a phantom.
      expect(normalizeClaudeStatus(envelopeEvent(dir), 100), name).toEqual({
        kind: "turn-end",
        at: 100,
      });
    }
  });

  it("declares nothing for an agent that declared no keys", () => {
    // codex arms the script with its id alone. `shift` leaves no keys, the
    // loop never runs, and the reduction is the bare event name — byte for
    // byte what it published before any of this existed.
    const dir = inbox();
    run(dir, oversized({ hook_event_name: "Stop" }), "codex", []);
    expect(envelope(dir)).toMatchObject({
      payload: { agent: "codex", event: { hook_event_name: "Stop" }, reduced: [] },
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
    // A nested list can still ride along on the keep-key pass, and that is
    // harmless BY CONSTRUCTION rather than by luck: `outlivesTurn` is
    // consulted only for `Stop`, and a `Stop`'s own bulk is prose, where
    // JSON escaping puts every key out of the anchors' reach.
    expect(normalizeClaudeStatus(envelopeEvent(dir), 100)).toEqual({
      kind: "resumed",
      at: 100,
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
