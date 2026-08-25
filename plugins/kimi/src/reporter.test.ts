import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runReporter, startDeck } from "../../../scripts/reporterHarness";

const SCRIPT = fileURLToPath(
  new URL(
    "../resources/keepdeck-session-reporter/kd-session-hook.sh",
    import.meta.url,
  ),
);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "keepdeck-kimi-reporter-"));
  dirs.push(dir);
  return dir;
}

/** The deck this reporter posts to. It used to drop a file in a directory the
 * deck watched; that lane is gone. */
let deck: Awaited<ReturnType<typeof startDeck>>;
beforeEach(async () => {
  deck = await startDeck();
});
afterEach(() => deck.close());

/**
 * The `kimi` argument is what kimi.plugin.json arms the hook with, and it is
 * what selects the session-index branch below — the reporter is one shared
 * script and the agent id is how it knows whose payload it is holding.
 *
 * `armed: false` where a case composes the environment itself: these exercise
 * the inert path and kimi's own $HOME, so the bridge var is theirs to set.
 */
function runHook(payload: unknown, env: Record<string, string>) {
  return runReporter(SCRIPT, {
    stdin: JSON.stringify(payload),
    args: ["kimi"],
    baseEnv: env,
    armed: false,
  });
}

/** The bridge env a KeepDeck-spawned kimi carries, pointed at this deck. */
const bridge = () =>
  JSON.stringify({
    v: 2,
    dir: scratch(),
    pane: "pane-kimi",
    token: "token-kimi",
    url: deck.url,
  });

/** The posted payload minus the reporting process, whose value is a live
 * process group — asserted for shape here rather than in every case. */
function publishedPayload(nth = 0): Record<string, unknown> {
  const posted = deck.envelopes[nth] as Record<string, unknown>;
  const { reporter, ...payload } = posted.payload as Record<string, unknown>;
  expect(reporter, "the reporting process group").toMatch(/^\d+$/);
  return payload;
}

describe("Kimi SessionStart reporter", () => {
  it("is inert outside a KeepDeck-spawned Kimi process", async () => {
    await runHook(
      { session_id: "session_outside" },
      { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    );
    expect(deck.envelopes).toEqual([]);
  });

  it("reports one bridge-v2 session binding", async () => {
    await runHook(
      {
        hook_event_name: "SessionStart",
        session_id: "session_24f9c57a",
        cwd: "/repo",
        source: "resume",
      },
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        KEEPDECK_BRIDGE: bridge(),
      },
    );

    expect(deck.envelopes).toHaveLength(1);
    const parsed = deck.envelopes[0] as Record<string, unknown>;
    expect({ ...parsed, payload: publishedPayload() }).toEqual({
      v: 2,
      type: "session.bound",
      paneId: "pane-kimi",
      token: "token-kimi",
      payload: {
        agent: "kimi",
        sessionId: "session_24f9c57a",
        source: "resume",
      },
    });
  });

  it("resolves the wire.jsonl transcript through the session index", async () => {
    // A fake $HOME carrying kimi's session index; the LAST line for the id
    // wins (kimi appends on every open).
    const home = scratch();
    const kimiDir = join(home, ".kimi-code");
    mkdirSync(kimiDir, { recursive: true });
    writeFileSync(
      join(kimiDir, "session_index.jsonl"),
      [
        JSON.stringify({
          sessionId: "session_abc",
          sessionDir: "/old/dir",
          workDir: "/repo",
        }),
        JSON.stringify({
          sessionId: "session_abc",
          sessionDir: `${home}/sessions/wd_repo/session_abc`,
          workDir: "/repo",
        }),
        "",
      ].join("\n"),
    );

    await runHook(
      { hook_event_name: "SessionStart", session_id: "session_abc" },
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        KEEPDECK_BRIDGE: bridge(),
      },
    );

    expect(deck.envelopes).toHaveLength(1);
    expect(publishedPayload()).toEqual({
      agent: "kimi",
      sessionId: "session_abc",
      transcriptPath: `${home}/sessions/wd_repo/session_abc/agents/main/wire.jsonl`,
    });
  });

  it("drops a JSON-hostile session dir rather than the whole binding", async () => {
    const home = scratch();
    const kimiDir = join(home, ".kimi-code");
    mkdirSync(kimiDir, { recursive: true });
    writeFileSync(
      join(kimiDir, "session_index.jsonl"),
      JSON.stringify({
        sessionId: "session_abc",
        sessionDir: `${home}/se"ssions/session_abc`,
        workDir: "/repo",
      }) + "\n",
    );
    await runHook(
      { hook_event_name: "SessionStart", session_id: "session_abc" },
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        KEEPDECK_BRIDGE: bridge(),
      },
    );
    expect(deck.envelopes).toHaveLength(1);
    expect(publishedPayload()).toEqual({
      agent: "kimi",
      sessionId: "session_abc",
    });
  });

  it("binds bare when the index has not recorded the session yet", async () => {
    const home = scratch(); // no .kimi-code at all
    await runHook(
      { hook_event_name: "SessionStart", session_id: "session_new" },
      {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        KEEPDECK_BRIDGE: bridge(),
      },
    );
    expect(deck.envelopes).toHaveLength(1);
    expect(publishedPayload()).toEqual({
      agent: "kimi",
      sessionId: "session_new",
    });
  });
});
