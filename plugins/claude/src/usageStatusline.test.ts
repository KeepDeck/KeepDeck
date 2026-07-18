import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
function inbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "kd-usage-test-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(stdin: string, bridge: object | null): string {
  const env = { ...process.env };
  delete env.KEEPDECK_BRIDGE;
  if (bridge) env.KEEPDECK_BRIDGE = JSON.stringify(bridge);
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
