import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * How the server half learns the route changed — with the directory watcher
 * standing in for the one opencode's runtime actually has. Bun on macOS
 * reports the observer's atomic write as a rename of its TMP name only
 * (measured live, task-443); Node reports the final name too, so a suite
 * running on Node's own watcher could never see the follower go deaf.
 */
const watcher = vi.hoisted(() => ({ fire: (_name: string | null) => {} }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    watch: (_dir: string, listener: (event: string, name: string | null) => void) => {
      watcher.fire = (name) => listener("rename", name);
      return { unref() {}, close() {} };
    },
  };
});

import { HEARTBEAT_MS, STALE_MS, watchForeground, writeForeground } from "../resources/keepdeck-plugin/foreground.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kd-fgwatch-"));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("watching the route", () => {
  it("follows a write the watcher reports only by its temporary name", () => {
    const seen: unknown[] = [];
    watchForeground(dir, (state: unknown) => seen.push(state));
    writeForeground(dir, { route: "session", sessionID: "ses_b" });
    watcher.fire(`foreground.json.${process.pid}.tmp`);
    expect(seen).toEqual([{ kind: "unknown" }, { kind: "session", sessionID: "ses_b" }]);
  });

  it("says nothing new for a heartbeat that changed nothing", () => {
    const seen: unknown[] = [];
    writeForeground(dir, { route: "home" });
    watchForeground(dir, (state: unknown) => seen.push(state));
    writeForeground(dir, { route: "home" });
    watcher.fire(null);
    expect(seen).toEqual([{ kind: "home" }]);
  });

  it("notices a TUI that stopped writing, though no event says so", () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const seen: unknown[] = [];
    writeForeground(dir, { route: "session", sessionID: "ses_a" });
    watchForeground(dir, (state: unknown) => seen.push(state));
    vi.advanceTimersByTime(STALE_MS + HEARTBEAT_MS);
    expect(seen).toEqual([{ kind: "session", sessionID: "ses_a" }, { kind: "stale" }]);
  });
});
