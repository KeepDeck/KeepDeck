import { execFileSync } from "node:child_process";
import {
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

/** Write a `.claude/settings.json` (or `settings.local.json`) under `root`,
 * the layout claude reads both a user home and a project root as. */
function settings(root: string, value: object, local = false): string {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", local ? "settings.local.json" : "settings.json"),
    typeof value === "string" ? value : JSON.stringify(value),
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
  delete env.KEEPDECK_STATUSLINE_INNER;
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
 * `--settings` outranks every settings file on disk. So it resolves whatever
 * they configured and hands the payload on, which means these tests are as
 * much about NOT delegating (to the wrong command, to ourselves, on a broken
 * file) as about delegating.
 */
describe("kd-usage-statusline.sh delegation", () => {
  /** A payload whose `workspace.project_dir` points at `project`. */
  const payload = (project: string) =>
    JSON.stringify({ ...STATUSLINE, workspace: { project_dir: project } });

  it("renders the user's own statusLine instead of the footer", () => {
    const home = settings(tmp(), statusLine("echo MY-OWN-LINE"));
    const stdout = run(payload(tmp()), null, { home });
    expect(stdout.trim()).toBe("MY-OWN-LINE");
  });

  it("feeds the delegate the same stdin it received", () => {
    const home = settings(tmp(), statusLine("cat"));
    const stdout = run(payload(tmp()), null, { home });
    // Verbatim: the delegate can read every field claude sent, not a digest.
    expect(JSON.parse(stdout).rate_limits).toEqual(STATUSLINE.rate_limits);
  });

  it("passes multi-line and ANSI output through untouched", () => {
    const home = settings(tmp(), statusLine("printf '\\033[32mrow1\\033[0m\\nrow2\\n'"));
    const stdout = run(payload(tmp()), null, { home });
    expect(stdout).toBe("[32mrow1[0m\nrow2\n");
  });

  it("publishes the usage envelope BEFORE running the delegate", () => {
    const dir = inbox();
    // Claude cancels an in-flight statusLine run when the next update lands;
    // a report queued behind a slow delegate would be the one dropped.
    const home = settings(tmp(), statusLine(`ls ${dir} | wc -l`));
    const stdout = run(payload(tmp()), { v: 1, dir, pane: "p", token: "t" }, {
      home,
    });
    expect(stdout.trim()).toBe("1");
  });

  it("falls back to the footer when the delegate fails", () => {
    const home = settings(tmp(), statusLine("exit 3"));
    expect(run(payload(tmp()), null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("falls back to the footer when the delegate draws nothing", () => {
    // Empty output blanks the status line — ours is better than nothing.
    const home = settings(tmp(), statusLine("true"));
    expect(run(payload(tmp()), null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("prefers project-local over project over user settings", () => {
    const home = settings(tmp(), statusLine("echo USER"));
    const project = settings(tmp(), statusLine("echo PROJECT"));
    expect(run(payload(project), null, { home }).trim()).toBe("PROJECT");

    settings(project, statusLine("echo PROJECT-LOCAL"), true);
    expect(run(payload(project), null, { home }).trim()).toBe("PROJECT-LOCAL");
  });

  it("resolves the project from cwd when the payload has no workspace", () => {
    const home = settings(tmp(), statusLine("echo USER"));
    const project = settings(tmp(), statusLine("echo PROJECT"));
    const stdin = JSON.stringify({ ...STATUSLINE, cwd: project });
    expect(run(stdin, null, { home }).trim()).toBe("PROJECT");
  });

  it("reads the user layer from CLAUDE_CONFIG_DIR when set", () => {
    const home = settings(tmp(), statusLine("echo WRONG-HOME"));
    const config = tmp();
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify(statusLine("echo FROM-CONFIG-DIR")),
    );
    const stdout = run(payload(tmp()), null, {
      home,
      env: { CLAUDE_CONFIG_DIR: config },
    });
    expect(stdout.trim()).toBe("FROM-CONFIG-DIR");
  });

  it("ignores a statusLine nested under another key", () => {
    // Depth-keyed, not text-matched: only the ROOT statusLine is the user's.
    const home = settings(tmp(), {
      plugins: { statusLine: { type: "command", command: "echo NESTED" } },
    });
    expect(run(payload(tmp()), null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("ignores a statusLine that is not a command", () => {
    const home = settings(tmp(), {
      statusLine: { type: "widget", command: "echo NOT-A-COMMAND" },
    });
    expect(run(payload(tmp()), null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("delegates to nothing when the settings file is truncated", () => {
    // Half a file must not yield half a command — an ambiguity is a miss.
    const home = tmp();
    mkdirSync(join(home, ".claude"));
    writeFileSync(
      join(home, ".claude", "settings.json"),
      '{ "statusLine": { "type": "command", "command": "echo TRUNCATED',
    );
    expect(run(payload(tmp()), null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("never delegates to itself", () => {
    const home = settings(tmp(), statusLine(`/bin/sh ${SCRIPT}`));
    expect(run(payload(tmp()), null, { home }).trim()).toBe("Opus · ctx 8%");
  });

  it("stays inert and silent when invoked as someone else's delegate", () => {
    const dir = inbox();
    // A user whose own statusLine WRAPS this script: the sentinel stops the
    // inner run from delegating again and from double-reporting the payload.
    const home = settings(tmp(), statusLine("echo OUTER-ONLY"));
    const stdout = run(payload(tmp()), { v: 1, dir, pane: "p", token: "t" }, {
      home,
      env: { KEEPDECK_STATUSLINE_INNER: "1" },
    });
    expect(stdout.trim()).toBe("Opus · ctx 8%");
    expect(envelopes(dir)).toHaveLength(0);
  });
});
