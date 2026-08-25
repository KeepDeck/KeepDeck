import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runReporter, startDeck } from "../../../scripts/reporterHarness";

/**
 * The SessionStart reporter, EXECUTED on the payload shapes claude and codex
 * produce. It runs the SHIPPED copy, like every other reporter suite: that is
 * what a spawned CLI opens, and the canonical file under resources/reporters/
 * is a template whose `@include`s only exist once rendered. What pins the
 * copies to that template is scripts/reporterScripts.test.mjs. kimi's own
 * branch (transcript through its session index) is covered against kimi's
 * copy in plugins/kimi/src/reporter.test.ts.
 *
 * What it reports goes to a stand-in deck rather than into a directory: the
 * reporter posts now, and a suite that still read files would be checking a
 * lane nothing uses.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/kd-session-hook.sh",
);

let deck: Awaited<ReturnType<typeof startDeck>>;
beforeEach(async () => {
  deck = await startDeck();
});
afterEach(() => deck.close());

const run = (stdin: string, args: string[] = ["claude"]) =>
  runReporter(SCRIPT, { url: deck.url, stdin, args });

/**
 * The one envelope posted, with the reporting process split off: its value is
 * a live process group, so it is asserted for SHAPE here once and by identity
 * in the dedicated case below, and the payload assertions stay exact.
 */
function envelope(): {
  envelope: Record<string, unknown>;
  reporter: unknown;
} {
  expect(deck.envelopes).toHaveLength(1);
  const posted = deck.envelopes[0] as Record<string, unknown>;
  const { reporter, ...payload } = posted.payload as Record<string, unknown>;
  return { envelope: { ...posted, payload }, reporter };
}

describe("kd-session-hook.sh", () => {
  it("names the reporting agent and why the session started", async () => {
    await run(
      JSON.stringify({
        session_id: "sid-1",
        transcript_path: "/x/sessions/rollout-1.jsonl",
        source: "startup",
      }),
    );
    const published = envelope();
    expect(published.envelope).toEqual({
      v: 2,
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

  it("names its parent's process GROUP, the one thing two invocations share", async () => {
    // The deck pins a pane's generation to this value and refuses anything
    // else, so it has to be the same for every hook event of one agent and
    // different for a CLI started from a tool call. Only the parent's GROUP
    // has that shape: the hook's own pid changes per invocation, and agents
    // spawn hooks detached so its own group does too.
    //
    // Asserted against the group this test process is in — the script's
    // parent here is the shell vitest spawns, which shares it. That is what
    // makes this fail for `$$` or `$PPID` rather than merely comparing two
    // runs to each other, which every candidate would pass.
    const group = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)])
      .toString()
      .trim();
    await run(JSON.stringify({ session_id: "sid-1" }));
    await run(JSON.stringify({ session_id: "sid-2" }));
    const reporters = deck.envelopes.map(
      (posted: Record<string, any>) => posted.payload.reporter,
    );
    expect(reporters).toEqual([group, group]);
  });

  it("binds with neither a transcript path nor a source", async () => {
    await run(JSON.stringify({ session_id: "sid-1" }));
    expect(envelope().envelope).toEqual({
      v: 2,
      type: "session.bound",
      paneId: "pane-3",
      token: "tok",
      payload: { agent: "claude", sessionId: "sid-1" },
    });
  });

  it("drops a JSON-hostile transcript path rather than the whole binding", async () => {
    // A quote in a path component would corrupt the printf'd envelope and
    // cost the pane its identity — the guard falls back to a bare bind.
    await run(
      JSON.stringify({
        session_id: "sid-1",
        transcript_path: '/Users/me/pro"j/rollout.jsonl',
      }),
    );
    expect(envelope().envelope.payload).toEqual({
      agent: "claude",
      sessionId: "sid-1",
    });
  });

  it("drops a source that would break the envelope, and only that", async () => {
    await run(JSON.stringify({ session_id: "sid-1", source: 'star"tup' }));
    expect(envelope().envelope.payload).toEqual({
      agent: "claude",
      sessionId: "sid-1",
    });
  });

  it("keeps a source carrying digits, dashes or colons", async () => {
    // The guard must not NARROW: a dropped source reads as a fresh start, and
    // a fresh start is the case the deck refuses — so over-tight filtering
    // costs a legitimate rebind rather than preventing anything.
    await run(JSON.stringify({ session_id: "sid-1", source: "auto-compact:2" }));
    expect(envelope().envelope.payload).toMatchObject({ source: "auto-compact:2" });
  });

  it("takes the FIRST source, not a later one nested in the payload", async () => {
    // Hook payloads are compact single-line JSON, so a line-oriented `head`
    // is no protection against sed's greedy match. The direction matters: an
    // inner "resume" overriding a real "startup" turns a fresh session into a
    // continuation, which is the one verdict that overwrites the pane.
    await run(
      JSON.stringify({
        session_id: "sid-1",
        source: "startup",
        tool_input: { source: "resume" },
      }),
    );
    expect(envelope().envelope.payload).toMatchObject({ source: "startup" });
  });

  it("publishes nothing when the session id would break the envelope", async () => {
    // The id has no bare fallback: a quote closes the JSON string mid-value
    // and the bridge drops the envelope unread. Saying nothing reaches the
    // same place without leaving garbage in the inbox.
    await run(JSON.stringify({ session_id: 'ab"cd' }));
    expect(deck.envelopes).toEqual([]);
  });

  it("publishes nothing when the arming site forgot the agent argument", async () => {
    // An unattributed binding is one the deck would have to refuse anyway;
    // saying nothing keeps the pane on the binding it already has.
    await run(JSON.stringify({ session_id: "sid-1" }), []);
    expect(deck.envelopes).toEqual([]);
  });
});
