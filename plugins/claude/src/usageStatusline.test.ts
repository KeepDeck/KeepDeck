import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const inbox = tmp;
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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
function run(
  stdin: string,
  bridge: object | null,
  opts: { home?: string; env?: Record<string, string> } = {},
): string {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.KEEPDECK_BRIDGE;
  delete env.KEEPDECK_STATUSLINE_NESTED;
  delete env.CLAUDE_CONFIG_DIR;
  env.HOME = opts.home ?? tmp();
  if (bridge) env.KEEPDECK_BRIDGE = JSON.stringify(bridge);
  Object.assign(env, opts.env ?? {});
  return execFileSync("/bin/sh", [SCRIPT], { input: stdin, env }).toString();
}

function envelopes(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

describe("kd-usage-statusline.sh", () => {
  it("publishes the stdin verbatim as a usage.report envelope", () => {
    const dir = inbox();
    const stdout = run(JSON.stringify(STATUSLINE), {
      v: 1,
      dir,
      pane: "pane-7",
      token: "tok-1",
    });

    const files = envelopes(dir);
    expect(files).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    expect(envelope.v).toBe(1);
    expect(envelope.type).toBe("usage.report");
    expect(envelope.paneId).toBe("pane-7");
    expect(envelope.token).toBe("tok-1");
    expect(envelope.payload.agent).toBe("claude");
    expect(envelope.payload.statusline).toEqual(STATUSLINE);
    // No half-written tmp stage left behind.
    expect(readdirSync(dir)).toHaveLength(1);

    expect(stdout.trim()).toBe("Opus · ctx 8%");
  });

  it("still prints the footer when the bridge env is absent", () => {
    const stdout = run(JSON.stringify(STATUSLINE), null);
    expect(stdout.trim()).toBe("Opus · ctx 8%");
  });

  it("drops non-JSON stdin without publishing", () => {
    const dir = inbox();
    const stdout = run("not json at all", {
      v: 1,
      dir,
      pane: "pane-7",
      token: "tok-1",
    });
    expect(envelopes(dir)).toHaveLength(0);
    expect(stdout.trim()).toBe("");
  });

  it("degrades the footer to the model alone without context data", () => {
    const payload = { model: { display_name: "Opus" } };
    const stdout = run(JSON.stringify(payload), null);
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

  it("renders the user's own statusLine instead of the footer", () => {
    const home = settings(tmp(), statusLine("echo MY-OWN-LINE"));
    const stdout = run(payload, null, { home });
    expect(stdout.trim()).toBe("MY-OWN-LINE");
  });

  it("feeds the delegate the exact stdin it received", () => {
    const home = settings(tmp(), statusLine("cat"));
    // The delegate is `cat`, so its stdout IS what we handed it — assert the
    // whole payload byte for byte, not one field a reserialization could
    // preserve while dropping the rest.
    expect(run(payload, null, { home })).toBe(payload);
  });

  it("passes multi-line and ANSI output through untouched", () => {
    const home = settings(tmp(), statusLine("printf '\\033[32mrow1\\033[0m\\nrow2\\n'"));
    const stdout = run(payload, null, { home });
    expect(stdout).toBe("[32mrow1[0m\nrow2\n");
  });

  it("preserves trailing blank rows the delegate emits", () => {
    // A file capture, not `$( )`, so trailing newlines survive byte for byte
    // (`$( )` would collapse them and the pane would lose the spacer rows).
    const home = settings(tmp(), statusLine("printf 'a\\nb\\n\\n\\n'"));
    expect(run(payload, null, { home })).toBe("a\nb\n\n\n");
  });

  it("does not block on a child the delegate backgrounds", () => {
    // "Print the cached line, refresh asynchronously" is the standard fast
    // statusline shape. Command substitution would hang until the background
    // job exits; a file capture returns as soon as the foreground line is out.
    const dir = tmp();
    const marker = join(dir, "marker");
    const home = settings(
      tmp(),
      statusLine(`echo LINE; (sleep 3; touch ${marker}) &`),
    );
    expect(run(payload, null, { home }).trim()).toBe("LINE");
    // Had we waited for the child, the marker would already exist.
    expect(existsSync(marker)).toBe(false);
  });

  it("passes the delegate the nested sentinel so it cannot re-delegate", () => {
    const home = settings(
      tmp(),
      statusLine('printf "INNER=%s" "$KEEPDECK_STATUSLINE_NESTED"'),
    );
    expect(run(payload, null, { home })).toBe("INNER=1");
  });

  it("keeps the delegate's stderr out of the rendered row", () => {
    const home = settings(tmp(), statusLine("echo ROW; echo noise >&2"));
    expect(run(payload, null, { home }).trim()).toBe("ROW");
  });

  it("publishes the usage envelope BEFORE running the delegate", () => {
    const dir = inbox();
    // Claude cancels an in-flight statusLine run when the next update lands;
    // a report queued behind a slow delegate would be the one dropped.
    const home = settings(tmp(), statusLine(`ls ${dir} | wc -l`));
    const stdout = run(payload, { v: 1, dir, pane: "p", token: "t" }, {
      home,
    });
    expect(stdout.trim()).toBe("1");
  });

  it("falls back to the footer when the delegate fails", () => {
    const home = settings(tmp(), statusLine("exit 3"));
    expect(run(payload, null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("falls back to the footer when the delegate draws nothing", () => {
    // Empty output blanks the status line — ours is better than nothing.
    const home = settings(tmp(), statusLine("true"));
    expect(run(payload, null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("still reports and delegates when stdin has leading whitespace", () => {
    // The JSON-shape gate trims before checking, so one stray byte does not
    // blank the row and starve the report.
    const dir = inbox();
    const home = settings(tmp(), statusLine("echo TRIMMED"));
    const stdout = run(` \n${payload}`, { v: 1, dir, pane: "p", token: "t" }, {
      home,
    });
    expect(stdout.trim()).toBe("TRIMMED");
    expect(envelopes(dir)).toHaveLength(1);
  });

  it("reads the user layer from CLAUDE_CONFIG_DIR when set", () => {
    const home = settings(tmp(), statusLine("echo WRONG-HOME"));
    const config = tmp();
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify(statusLine("echo FROM-CONFIG-DIR")),
    );
    const stdout = run(payload, null, {
      home,
      env: { CLAUDE_CONFIG_DIR: config },
    });
    expect(stdout.trim()).toBe("FROM-CONFIG-DIR");
  });

  it("resolves a settings file with CRLF line endings", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify(statusLine("echo CRLF")).replace(/,/g, ",\r\n"),
    );
    expect(run(payload, null, { home }).trim()).toBe("CRLF");
  });

  it("delegates to the LAST of duplicate statusLine keys, as JSON does", () => {
    // JSON.parse is last-wins; a first-hit reader would run a command claude
    // itself would never use.
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{"statusLine":{"type":"command","command":"echo FIRST"},' +
        '"statusLine":{"type":"command","command":"echo LAST"}}',
    );
    expect(run(payload, null, { home }).trim()).toBe("LAST");
  });

  it("is not tripped by an escape in an unrelated field", () => {
    // A multi-line `hooks` command (a `\n` escape) before statusLine must not
    // abort the whole scan — the taint is scoped to the value it sits in.
    const home = settings(tmp(), {
      hooks: { Stop: [{ hooks: [{ type: "command", command: "a\nb" }] }] },
      statusLine: { type: "command", command: "echo SURVIVED" },
    });
    expect(run(payload, null, { home }).trim()).toBe("SURVIVED");
  });

  it("ignores a statusLine nested under another key", () => {
    // Depth-keyed, not text-matched: only the ROOT statusLine is the user's.
    const home = settings(tmp(), {
      plugins: { statusLine: { type: "command", command: "echo NESTED" } },
    });
    expect(run(payload, null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("ignores a statusLine that is not a command", () => {
    const home = settings(tmp(), {
      statusLine: { type: "widget", command: "echo NOT-A-COMMAND" },
    });
    expect(run(payload, null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("delegates to nothing when a value is truncated mid-string", () => {
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{ "statusLine": { "type": "command", "command": "echo TRUNCATED',
    );
    expect(run(payload, null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("delegates to nothing when the braces are truncated after the value", () => {
    // A complete command string but an unbalanced document — claude rejects it
    // outright, so a half-captured command must not slip through.
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{"statusLine":{"type":"command","command":"echo RAN"',
    );
    expect(run(payload, null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("drops a delegate command that names its own script", () => {
    // The guard is a substring match, which is exactly what lets us observe
    // it: remove the guard and this harmless echo would run and print its
    // marker instead of the footer.
    const home = settings(tmp(), statusLine("echo ran-kd-usage-statusline.sh"));
    expect(run(payload, null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("stays inert and silent when invoked as someone else's delegate", () => {
    const dir = inbox();
    // A user whose own statusLine WRAPS this script: the sentinel stops the
    // inner run from delegating again and from double-reporting the payload.
    const home = settings(tmp(), statusLine("echo OUTER-ONLY"));
    const stdout = run(payload, { v: 1, dir, pane: "p", token: "t" }, {
      home,
      env: { KEEPDECK_STATUSLINE_NESTED: "1" },
    });
    expect(stdout.trim()).toBe("Opus · ctx 8%");
    expect(envelopes(dir)).toHaveLength(0);
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

  it("never delegates to a statusLine committed in the project", () => {
    const project = settings(tmp(), statusLine("echo REPO-CONTROLLED"));
    const stdout = run(inProject(project), null, { home: tmp() });
    expect(stdout.trim()).toBe("Opus · ctx 8%");
  });

  it("keeps the user's own statusLine when the project defines one too", () => {
    const project = settings(tmp(), statusLine("echo REPO-CONTROLLED"));
    const home = settings(tmp(), statusLine("echo MINE"));
    expect(run(inProject(project), null, { home }).trim()).toBe("MINE");
  });
});
