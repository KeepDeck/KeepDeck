import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runReporter, startDeck } from "../../../scripts/reporterHarness";
import { normalizeClaudeStatus } from "./status";

/**
 * The status reporter, EXECUTED — scripts/reporterScripts.test.mjs pins every
 * shipped copy to the canonical file under resources/reporters/, but only
 * running one proves the envelope and the oversize degradation actually work
 * in a shell. Running the shipped copy rather than the canonical one is
 * deliberate: it is what a spawned CLI opens.
 *
 * What it reports goes to a stand-in deck. It used to go into a directory the
 * deck watched, and that lane is gone.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/kd-status-hook.sh",
);

let deck: Awaited<ReturnType<typeof startDeck>>;
beforeEach(async () => {
  deck = await startDeck();
});
afterEach(() => deck.close());

/** A UTF-8 ambient locale, ALWAYS — the script overrides it, and that
 * override is what the invalid-byte case below proves. Inheriting the
 * runner's locale instead would make that proof environment-dependent: on a
 * CI container with LC_ALL unset the ambient locale is already C, the
 * override becomes a no-op, and the test would pass with it deleted. */
const LOCALE = { LC_ALL: "en_US.UTF-8" };

function hook(
  args: string[],
  // A Buffer too: one case feeds a byte no UTF-8 locale accepts, which a
  // string cannot carry.
  stdin: string | Buffer,
  armed = true,
) {
  return runReporter(SCRIPT, { url: deck.url, stdin, args, env: LOCALE, armed });
}

const run = (stdin: string | Buffer, agent = "claude") => hook([agent], stdin);

/** A payload guaranteed to trip the reduction, in the shape that actually
 * drives it in the field: a huge final assistant message. */
function oversized(event: Record<string, unknown>): string {
  return JSON.stringify({ ...event, last_assistant_message: "ж".repeat(140_000) });
}

/** The posted envelope as the normalizer receives it — so a reduction can be
 * judged by the EDGE it produces, not by its serialized shape. */
function envelopeEvent(nth = 0): unknown {
  return (envelope(nth) as { payload: unknown }).payload;
}

function envelope(nth = 0): Record<string, unknown> {
  expect(deck.envelopes.length).toBeGreaterThan(nth);
  return deck.envelopes[nth] as Record<string, unknown>;
}

describe("kd-status-hook.sh", () => {
  it("wraps the hook payload verbatim under the agent's envelope", async () => {
    await run(JSON.stringify({ hook_event_name: "Stop", extra: "kept" }));
    expect(envelope()).toEqual({
      v: 2,
      type: "agent.status",
      paneId: "pane-3",
      token: "tok",
      payload: {
        agent: "claude",
        // The reporting process — the deck pins a pane's identity to it and
        // refuses reports from another, so this lane carries it too.
        reporter: expect.stringMatching(/^\d+$/),
        event: { hook_event_name: "Stop", extra: "kept" },
      },
    });
  });

  it("carries a compaction's `source` through to the edge", async () => {
    // The whole oversize-failure recovery rests on one field surviving the
    // shell: `source`. The script forwards payloads verbatim, so nothing
    // here is agent-specific — but nothing PINNED that for this event, and
    // a reduction or an extraction added later would silently turn every
    // compaction into "not a compaction", putting the pane back to staying
    // red forever with every unit test still green.
    await run(
      JSON.stringify({
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: "6b1641cc",
      }),
    );
    expect(normalizeClaudeStatus(envelopeEvent(), 100)).toEqual({
      kind: "context-compacted",
      at: 100,
    });

    // And the sibling source that must NOT read as one — a pane boots far
    // more often than it compacts.
    await run(
      JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }),
    );
    expect(normalizeClaudeStatus(envelopeEvent(1), 100)).toBeNull();
  });

  it("reduces only past the bridge's own limit, measured in BYTES", async () => {
    // Under the cap the payload rides whole. The guard used to fire at half
    // the size that needs it, reducing payloads the bridge would have
    // delivered intact and widening every lossy failure below.
    await run(
      JSON.stringify({
        hook_event_name: "Stop",
        last_assistant_message: "ж".repeat(70_000),
      }),
    );
    expect(JSON.stringify(envelope())).toContain("last_assistant_message");

    // Past it, the reduced shape. CYRILLIC is 2 bytes a character, so a
    // character count would wave this through.
    await run(oversized({ hook_event_name: "Stop" }));
    // EXACT, not a subset: the event name is all a reduction may carry, and
    // a partial match would let a field creep back in unnoticed — which is
    // how the value-copying and the invented task entry both shipped.
    expect(envelope(1)).toEqual({
      v: 2,
      type: "agent.status",
      paneId: "pane-3",
      token: "tok",
      payload: {
        agent: "claude",
        reporter: expect.stringMatching(/^\d+$/),
        event: { hook_event_name: "Stop" },
      },
    });
  });

  it("a reduced payload stays parseable whatever the values held", async () => {
    // The reduction copies NO value out, so nothing it emits can be broken
    // by what a value contained. `"[^"]*"` would stop at the backslash of an
    // escaped quote and close the envelope mid-string, and the bridge drops
    // a malformed envelope WHOLE — losing the edge entirely. Only the event
    // name survives, and only because its charset is constrained to [A-Za-z].
    await run(
      oversized({
        hook_event_name: "StopFailure",
        error: 'say "hi" now',
        tool_response: { structuredContent: { detail: 'nested "quoted" text\\' } },
      }),
    );
    expect(envelope()).toMatchObject({
      payload: { agent: "claude", event: { hook_event_name: "StopFailure" } },
    });
    // The error CLASS goes with every other value — a deliberate
    // degradation: the badge reads "Turn failed" instead of naming the rate
    // limit. Degraded is recoverable; a dropped envelope is not.
    expect(normalizeClaudeStatus(envelopeEvent(), 100)).toEqual({
      kind: "turn-failed",
      at: 100,
      error: "unknown",
    });
  });

  it("survives a byte no UTF-8 locale would accept", async () => {
    // `tr` ABORTS at the first invalid byte under a UTF-8 locale and
    // truncates its output. The bad byte here sits BEFORE the event name —
    // claude's payload leads with paths, and a path is bytes, not text — so
    // a truncating `tr` would take the name with it and the whole envelope
    // would be dropped. Under LC_ALL=C a payload is bytes and it survives.
    const pad = Buffer.from("ж".repeat(140_000), "utf8");
    await run(
      Buffer.concat([
        Buffer.from('{"cwd":"/tmp/'),
        Buffer.from([0xff]),
        Buffer.from('","hook_event_name":"Stop","last_assistant_message":"'),
        pad,
        Buffer.from('"}'),
      ]),
    );
    expect(envelope()).toMatchObject({
      payload: { event: { hook_event_name: "Stop" } },
    });
  });

  it("finds the event name however the payload is formatted", async () => {
    // grep and sed are line-oriented; JSON's structural whitespace is not.
    await run(
      JSON.stringify(
        { hook_event_name: "Stop", last_assistant_message: "ж".repeat(140_000) },
        null,
        2,
      ),
    );
    expect(envelope()).toMatchObject({
      payload: { event: { hook_event_name: "Stop" } },
    });
  });

  it("reads the payload's OWN event name, not a NESTED one", async () => {
    // A tool result is arbitrary JSON, and structured output nests real
    // objects — whose keys are NOT escaped and so do match the anchors.
    // A greedy match took the LAST one, turning a mid-turn PostToolUse into
    // a Stop: a false "finished" banner over a running turn. The real key
    // leads in every schema we arm, so the FIRST match is the payload's own.
    await run(
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
    expect(envelope()).toMatchObject({
      payload: { event: { hook_event_name: "PostToolUse" } },
    });
    expect(normalizeClaudeStatus(envelopeEvent(), 100)).toEqual({
      kind: "resumed",
      at: 100,
    });
  });

  it("an oversized agent close survives as the CLEARING edge, not a named one", async () => {
    // SubagentStop is the one newly armed event that can realistically
    // cross the cap: it carries the agent's final message. Reduced, it
    // keeps its event name and loses `agent_id` — and the normalizer must
    // then report "I cannot name what closed" rather than a normal close,
    // because the host answers those two differently. The unit test pins
    // the mapping; this pins that the SHELL leaves exactly the field the
    // mapping depends on, for a payload whose layout (`agent_id`,
    // `agent_type`) differs from the events the script was tuned against.
    await run(
      oversized({
        hook_event_name: "SubagentStop",
        agent_id: "af40aa53702b05b1b",
        agent_type: "general-purpose",
      }),
    );
    expect(envelope()).toEqual({
      v: 2,
      type: "agent.status",
      paneId: "pane-3",
      token: "tok",
      payload: {
        agent: "claude",
        reporter: expect.stringMatching(/^\d+$/),
        event: { hook_event_name: "SubagentStop" },
      },
    });
    expect(normalizeClaudeStatus(envelopeEvent(), 100)).toEqual({
      kind: "agent-turns-cleared",
      at: 100,
    });
    // Under the cap the id rides whole and the close names its agent.
    await run(
      JSON.stringify({
        hook_event_name: "SubagentStop",
        agent_id: "af40aa53702b05b1b",
      }),
    );
    expect(normalizeClaudeStatus(envelopeEvent(1), 100)).toEqual({
      kind: "agent-turn-end",
      at: 100,
      id: "af40aa53702b05b1b",
    });
  });

  it("stays silent and reports nothing without bridge context, agent or stdin", async () => {
    // Bigger than any pipe buffer (64K on Linux). Both guards below exit
    // before reading stdin, so on an `input:` pipe the writer would break and
    // this test would fail on EVERY machine — instead of only on a loaded CI
    // runner, where the race hid until it finally fired.
    const waiting = `{"a":"${"x".repeat(200_000)}"}`;
    // No agent argument.
    await hook([], waiting);
    // Empty stdin.
    await run("");
    // No bridge var at all.
    await hook(["claude"], waiting, false);
    expect(deck.envelopes).toEqual([]);
  });
});
