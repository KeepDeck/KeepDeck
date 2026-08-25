import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runReporter, startDeck } from "../../../scripts/reporterHarness";

/**
 * The statusLine reporter is a real shell script — exercise it end-to-end:
 * feed it the documented stdin JSON, then assert the envelope it publishes
 * and the footer it prints. The envelope's `payload.statusline` must be the
 * stdin VERBATIM (the webview normalizer owns the schema; a reporter that
 * picks fields would silently strip future data).
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../resources/kd-usage-statusline.sh",
);

/** A trimmed copy of the documented statusLine stdin (docs 2.1.x): the
 * fields the reporter forwards plus the two the footer extracts. */
const STATUSLINE = {
  session_id: "abc-123",
  transcript_path: "/tmp/transcript.jsonl",
  model: { id: "claude-opus-4-8", display_name: "Opus" },
  cost: { total_cost_usd: 0.01234, total_duration_ms: 45_000 },
  context_window: {
    total_input_tokens: 15_500,
    context_window_size: 200_000,
    used_percentage: 8,
    remaining_percentage: 92,
    current_usage: { input_tokens: 8500, cache_read_input_tokens: 2000 },
  },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
    seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
  },
};

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "kd-usage-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The deck this reporter posts to. It used to post into a directory the deck
 * watched; that lane is gone, so the suite has to be something postable. */
let deck: Awaited<ReturnType<typeof startDeck>>;
beforeEach(async () => {
  deck = await startDeck();
});
afterEach(() => deck.close());

/** The bridge env a KeepDeck-spawned pane carries, pointed at this deck. */
const armed = () => ({ v: 2, dir: tmp(), pane: "p", token: "t", url: deck.url });

/** Write a `.claude/settings.json` under `root` — the layout claude reads
 * both a user home and a project root as. */
function settings(root: string, value: object): string {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify(value),
  );
  return root;
}

/** A statusLine settings object delegating to `command`. */
const statusLine = (command: string) => ({
  statusLine: { type: "command", command },
});

/**
 * HOME is ALWAYS isolated: the developer running these tests may well have a
 * statusLine of their own in `~/.claude/settings.json`, and the script is now
 * built to find exactly that — an inherited HOME would make every assertion
 * here machine-dependent.
 */
async function run(
  stdin: string,
  bridge: object | null,
  opts: { home?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.KEEPDECK_BRIDGE;
  delete env.KEEPDECK_STATUSLINE_NESTED;
  delete env.CLAUDE_CONFIG_DIR;
  env.HOME = opts.home ?? tmp();
  if (bridge) env.KEEPDECK_BRIDGE = JSON.stringify(bridge);
  Object.assign(env, opts.env ?? {});
  // `armed: false` because this suite composes the whole environment itself,
  // bridge var included — the deck's address rides in the object it passes.
  const { stdout } = await runReporter(SCRIPT, {
    stdin,
    baseEnv: env,
    armed: false,
  });
  return stdout;
}

/** The one envelope posted, parsed. */
const posted = (nth = 0) => deck.envelopes[nth] as Record<string, any>;

describe("kd-usage-statusline.sh", () => {
  it("publishes the stdin verbatim as a usage.report envelope", async () => {
    const stdout = await run(JSON.stringify(STATUSLINE), {
      ...armed(),
      pane: "pane-7",
      token: "tok-1",
    });

    expect(deck.envelopes).toHaveLength(1);
    const envelope = posted();
    expect(envelope.v).toBe(2);
    expect(envelope.type).toBe("usage.report");
    expect(envelope.paneId).toBe("pane-7");
    expect(envelope.token).toBe("tok-1");
    expect(envelope.payload.agent).toBe("claude");
    expect(envelope.payload.statusline).toEqual(STATUSLINE);

    expect(stdout.trim()).toBe("Opus · ctx 8%");
  });

  it("stamps the report with the transcript's mtime as sourceMtimeMs", async () => {
    // The session's last-turn time rides along so freshest-wins ranks account
    // windows by capture time, not delivery time — an idle refresh echo (or a
    // long-idle session seen on a workspace switch) carries this OLD stamp and
    // cannot clobber an active session's fresher reading.
    const transcript = join(tmp(), "transcript.jsonl");
    writeFileSync(transcript, "{}");
    // Backdate to a DISTINCTIVE past instant so the assertion proves the stamp
    // is the TRANSCRIPT's mtime — not "now" from any other file the test
    // freshly created, which would read as the current whole second.
    const turnedAt = 1_700_000_000; // fixed epoch seconds, hours in the past
    utimesSync(transcript, turnedAt, turnedAt);
    await run(JSON.stringify({ ...STATUSLINE, transcript_path: transcript }), { ...armed(), pane: "p", token: "t" });
    const envelope = posted();
    // Whole-second precision (BSD `stat -f %m` / GNU `%Y`), promoted to ms.
    expect(envelope.payload.sourceMtimeMs).toBe(turnedAt * 1000);
    // Reading transcript_path never strips the verbatim statusline.
    expect(envelope.payload.statusline.transcript_path).toBe(transcript);
  });

  it("omits sourceMtimeMs when the transcript file is absent", async () => {
    // No file to stat → no stamp, and the report still publishes verbatim so
    // the chip degrades to arrival-time ranking rather than losing the report.
    const statusline = { ...STATUSLINE, transcript_path: "/no/such/kd-transcript.jsonl" };
    await run(JSON.stringify(statusline), armed());
    const envelope = posted();
    expect(envelope.payload.sourceMtimeMs).toBeUndefined();
    expect(envelope.payload.statusline).toEqual(statusline);
  });

  it("stamps a transcript path that contains spaces", async () => {
    // Every use of the path is double-quoted, so a space must not split it
    // into multiple stat arguments and silently disable stamping.
    const transcript = join(tmp(), "a session.jsonl");
    writeFileSync(transcript, "{}");
    const turnedAt = 1_700_000_500;
    utimesSync(transcript, turnedAt, turnedAt);
    await run(JSON.stringify({ ...STATUSLINE, transcript_path: transcript }), { ...armed(), pane: "p", token: "t" });
    const envelope = posted();
    expect(envelope.payload.sourceMtimeMs).toBe(turnedAt * 1000);
  });

  it("does not stamp a directory as a transcript — only a real file is a turn", async () => {
    // `-f` (regular file), never `-e`: a directory's mtime is not a turn time.
    await run(JSON.stringify({ ...STATUSLINE, transcript_path: tmp() }), { ...armed(), pane: "p", token: "t" });
    const envelope = posted();
    expect(envelope.payload.sourceMtimeMs).toBeUndefined();
  });

  it("degrades safely when the path holds a quote the naive sed cannot span", async () => {
    // Claude's JSON is arbitrary; an embedded quote truncates the sed capture
    // to a non-existent path → no stamp, no crash, and the statusline still
    // publishes verbatim (the quoted shell var means no mishap either).
    const statusline = { ...STATUSLINE, transcript_path: '/tmp/we"ird.jsonl' };
    await run(JSON.stringify(statusline), armed());
    const envelope = posted();
    expect(envelope.payload.sourceMtimeMs).toBeUndefined();
    expect(envelope.payload.statusline).toEqual(statusline);
  });

  it("still prints the footer when the bridge env is absent", async () => {
    const stdout = await run(JSON.stringify(STATUSLINE), null);
    expect(stdout.trim()).toBe("Opus · ctx 8%");
  });

  it("drops non-JSON stdin without publishing", async () => {
    const stdout = await run("not json at all", { ...armed(), pane: "pane-7", token: "tok-1" });
    expect(deck.envelopes).toHaveLength(0);
    expect(stdout.trim()).toBe("");
  });

  it("degrades the footer to the model alone without context data", async () => {
    const payload = { model: { display_name: "Opus" } };
    const stdout = await run(JSON.stringify(payload), null);
    expect(stdout.trim()).toBe("Opus");
  });
});

/**
 * Arming this script takes the statusLine slot away from the user's own —
 * `--settings` outranks every settings file a user edits. So it resolves
 * whatever they configured and hands the payload on, which means these tests
 * are as much about NOT delegating (to the wrong command, to a duplicate the
 * real parser would skip, to ourselves, on a broken file) as about delegating.
 */
describe("kd-usage-statusline.sh delegation", () => {
  const payload = JSON.stringify(STATUSLINE);

  it("renders the user's own statusLine instead of the footer", async () => {
    const home = settings(tmp(), statusLine("echo MY-OWN-LINE"));
    const stdout = await run(payload, null, { home });
    expect(stdout.trim()).toBe("MY-OWN-LINE");
  });

  it("feeds the delegate the exact stdin it received", async () => {
    const home = settings(tmp(), statusLine("cat"));
    // The delegate is `cat`, so its stdout IS what we handed it — assert the
    // whole payload byte for byte, not one field a reserialization could
    // preserve while dropping the rest.
    expect(await run(payload, null, { home })).toBe(payload);
  });

  it("passes multi-line and ANSI output through untouched", async () => {
    const home = settings(tmp(), statusLine("printf '\\033[32mrow1\\033[0m\\nrow2\\n'"));
    const stdout = await run(payload, null, { home });
    expect(stdout).toBe("[32mrow1[0m\nrow2\n");
  });

  it("preserves trailing blank rows the delegate emits", async () => {
    // A file capture, not `$( )`, so trailing newlines survive byte for byte
    // (`$( )` would collapse them and the pane would lose the spacer rows).
    const home = settings(tmp(), statusLine("printf 'a\\nb\\n\\n\\n'"));
    expect(await run(payload, null, { home })).toBe("a\nb\n\n\n");
  });

  it("does not block on a child the delegate backgrounds", async () => {
    // "Print the cached line, refresh asynchronously" is the standard fast
    // statusline shape. Command substitution would hang until the background
    // job exits; a file capture returns as soon as the foreground line is out.
    const dir = tmp();
    const marker = join(dir, "marker");
    const home = settings(
      tmp(),
      statusLine(`echo LINE; (sleep 3; touch ${marker}) &`),
    );
    expect((await run(payload, null, { home })).trim()).toBe("LINE");
    // Had we waited for the child, the marker would already exist.
    expect(existsSync(marker)).toBe(false);
  });

  it("passes the delegate the nested sentinel so it cannot re-delegate", async () => {
    const home = settings(
      tmp(),
      statusLine('printf "INNER=%s" "$KEEPDECK_STATUSLINE_NESTED"'),
    );
    expect(await run(payload, null, { home })).toBe("INNER=1");
  });

  it("keeps the delegate's stderr out of the rendered row", async () => {
    const home = settings(tmp(), statusLine("echo ROW; echo noise >&2"));
    expect((await run(payload, null, { home })).trim()).toBe("ROW");
  });

  it("reports the usage envelope BEFORE running the delegate", async () => {
    // Claude cancels an in-flight statusLine run when the next update lands;
    // a report queued behind a slow delegate would be the one dropped.
    //
    // Asked causally rather than by clock: the delegate leaves a marker, and
    // the deck looks for it AS the envelope arrives. Absent means the report
    // was already on its way before the delegate ran.
    const marker = join(tmp(), "delegate-ran");
    let ranFirst: boolean | null = null;
    await deck.close();
    deck = await startDeck(() => {
      ranFirst = existsSync(marker);
      return { status: 204 };
    });
    const home = settings(tmp(), statusLine(`touch ${marker}; echo ROW`));
    const stdout = await run(payload, armed(), { home });
    expect(stdout.trim()).toBe("ROW");
    expect(ranFirst).toBe(false);
  });

  it("falls back to the footer when the delegate fails", async () => {
    const home = settings(tmp(), statusLine("exit 3"));
    expect((await run(payload, null, { home })).trim()).toBe("Opus · ctx 8%");
  });

  it("falls back to the footer when the delegate draws nothing", async () => {
    // Empty output blanks the status line — ours is better than nothing.
    const home = settings(tmp(), statusLine("true"));
    expect((await run(payload, null, { home })).trim()).toBe("Opus · ctx 8%");
  });

  it("still reports and delegates when stdin has leading whitespace", async () => {
    // The JSON-shape gate trims before checking, so one stray byte does not
    // blank the row and starve the report.
    const home = settings(tmp(), statusLine("echo TRIMMED"));
    const stdout = await run(` \n${payload}`, armed(), {
      home,
    });
    expect(stdout.trim()).toBe("TRIMMED");
    expect(deck.envelopes).toHaveLength(1);
  });

  it("reads the user layer from CLAUDE_CONFIG_DIR when set", async () => {
    const home = settings(tmp(), statusLine("echo WRONG-HOME"));
    const config = tmp();
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify(statusLine("echo FROM-CONFIG-DIR")),
    );
    const stdout = await run(payload, null, {
      home,
      env: { CLAUDE_CONFIG_DIR: config },
    });
    expect(stdout.trim()).toBe("FROM-CONFIG-DIR");
  });

  it("resolves a settings file with CRLF line endings", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(statusLine("echo CRLF")).replace(/,/g, ",\r\n"),
    );
    expect((await run(payload, null, { home })).trim()).toBe("CRLF");
  });

  it("delegates to the LAST of duplicate statusLine keys, as JSON does", async () => {
    // JSON.parse is last-wins; a first-hit reader would run a command claude
    // itself would never use.
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{"statusLine":{"type":"command","command":"echo FIRST"},' +
        '"statusLine":{"type":"command","command":"echo LAST"}}',
    );
    expect((await run(payload, null, { home })).trim()).toBe("LAST");
  });

  it("is not tripped by an escape in an unrelated field", async () => {
    // A multi-line `hooks` command (a `\n` escape) before statusLine must not
    // abort the whole scan — the taint is scoped to the value it sits in.
    const home = settings(tmp(), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "a\nb" }] }] },
      statusLine: { type: "command", command: "echo SURVIVED" },
    });
    expect((await run(payload, null, { home })).trim()).toBe("SURVIVED");
  });

  it("ignores a statusLine nested under another key", async () => {
    // Depth-keyed, not text-matched: only the ROOT statusLine is the user's.
    const home = settings(tmp(), {
      plugins: { statusLine: { type: "command", command: "echo NESTED" } },
    });
    expect((await run(payload, null, { home })).trim()).toBe("Opus · ctx 8%");
  });

  it("ignores a statusLine that is not a command", async () => {
    const home = settings(tmp(), {
      statusLine: { type: "widget", command: "echo NOT-A-COMMAND" },
    });
    expect((await run(payload, null, { home })).trim()).toBe("Opus · ctx 8%");
  });

  it("delegates to nothing when a value is truncated mid-string", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{ "statusLine": { "type": "command", "command": "echo TRUNCATED',
    );
    expect((await run(payload, null, { home })).trim()).toBe("Opus · ctx 8%");
  });

  it("delegates to nothing when the braces are truncated after the value", async () => {
    // A complete command string but an unbalanced document — claude rejects it
    // outright, so a half-captured command must not slip through.
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{"statusLine":{"type":"command","command":"echo RAN"',
    );
    expect((await run(payload, null, { home })).trim()).toBe("Opus · ctx 8%");
  });

  it("drops a delegate command that names its own script", async () => {
    // The guard is a substring match, which is exactly what lets us observe
    // it: remove the guard and this harmless echo would run and print its
    // marker instead of the footer.
    const home = settings(tmp(), statusLine("echo ran-kd-usage-statusline.sh"));
    expect((await run(payload, null, { home })).trim()).toBe("Opus · ctx 8%");
  });

  it("stays inert and silent when invoked as someone else's delegate", async () => {
    // A user whose own statusLine WRAPS this script: the sentinel stops the
    // inner run from delegating again and from double-reporting the payload.
    const home = settings(tmp(), statusLine("echo OUTER-ONLY"));
    const stdout = await run(payload, armed(), {
      home,
      env: { KEEPDECK_STATUSLINE_NESTED: "1" },
    });
    expect(stdout.trim()).toBe("Opus · ctx 8%");
    expect(deck.envelopes).toHaveLength(0);
  });
});

/**
 * The security boundary, pinned. A project's `.claude/settings.json` is a
 * COMMITTED file, so honouring a statusLine found there would execute a
 * command chosen by whoever wrote the repository — on every clone and every
 * pulled branch. Claude gates project settings behind a directory-trust
 * prompt whose answer this script cannot see, so it reads the USER layer and
 * nothing else. Nothing here can be fixed by sanitizing: the field is a
 * command by design, so provenance is the only defence.
 */
describe("kd-usage-statusline.sh provenance", () => {
  /** Payload pointing at `project` every way claude describes a location. */
  const inProject = (project: string) =>
    JSON.stringify({
      ...STATUSLINE,
      cwd: project,
      workspace: { current_dir: project, project_dir: project },
    });

  it("never delegates to a statusLine committed in the project", async () => {
    const project = settings(tmp(), statusLine("echo REPO-CONTROLLED"));
    const stdout = await run(inProject(project), null, { home: tmp() });
    expect(stdout.trim()).toBe("Opus · ctx 8%");
  });

  it("keeps the user's own statusLine when the project defines one too", async () => {
    const project = settings(tmp(), statusLine("echo REPO-CONTROLLED"));
    const home = settings(tmp(), statusLine("echo MINE"));
    expect((await run(inProject(project), null, { home })).trim()).toBe("MINE");
  });
});
