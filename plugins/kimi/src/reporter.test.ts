import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

describe("Kimi SessionStart reporter", () => {
  it("is inert outside a KeepDeck-spawned Kimi process", () => {
    const dir = scratch();
    execFileSync("/bin/sh", [SCRIPT], {
      input: JSON.stringify({ session_id: "session_outside" }),
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("publishes one atomic bridge-v1 session binding", () => {
    const dir = scratch();
    execFileSync("/bin/sh", [SCRIPT], {
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "session_24f9c57a",
        cwd: "/repo",
        source: "resume",
      }),
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        KEEPDECK_BRIDGE: JSON.stringify({
          v: 1,
          dir,
          pane: "pane-kimi",
          token: "token-kimi",
        }),
      },
    });

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^session\.bound-.+\.json$/);
    expect(JSON.parse(readFileSync(join(dir, files[0]), "utf8"))).toEqual({
      v: 1,
      type: "session.bound",
      paneId: "pane-kimi",
      token: "token-kimi",
      payload: { sessionId: "session_24f9c57a" },
    });
  });
});
