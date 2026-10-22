/**
 * What the pane's TUI is showing, shared between the two halves of
 * KeepDeck's opencode 1.x integration (task-435).
 *
 * The server plugin cannot see the TUI: `/new` and `/sessions` only move the
 * TUI's own route, and the server hears nothing (packages/tui/src/app.tsx at
 * v1.19.3). Without this the courier went on delivering into a session the
 * user had left, and the agent worked there unseen. The TUI plugin
 * (route-observer.js) watches the route and writes it here; the server
 * plugin reads it. Two separate JS isolates of one process — the server is a
 * Worker (cli/cmd/tui.ts:249-253) — so a file in the pane's bridge directory
 * is the channel, not a module variable.
 *
 * The record: `{ route: "home" | "session" | "other", sessionID?, pid, at }`.
 * Rewritten on every change and once a second as a heartbeat, atomically.
 */
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FOREGROUND_FILE = "foreground.json";

/** How often the observer rewrites an unchanged route, so a reader can tell
 * a live TUI from one that stopped. */
export const HEARTBEAT_MS = 1_000;
/** Older than this, the TUI is not answering: trust none of it. */
export const STALE_MS = 3_000;
/** Older than this, the observer itself is gone while the process lives —
 * hold mail behind it no longer, and fall back to delivering as before it
 * existed. Waiting forever would be worse than the bug it fixes. */
export const DEAD_MS = 30_000;

/** Write the route for this process, atomically: a reader never sees half. */
export function writeForeground(dir, route, now = Date.now(), pid = process.pid) {
  const path = join(dir, FOREGROUND_FILE);
  const tmp = `${path}.${pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...route, pid, at: now }));
  renameSync(tmp, path);
}

/**
 * What the TUI is showing, as far as this process can trust it:
 *
 * - `unknown` — no observer is running for this process (no file, another
 *   process's file, or one that stopped long ago): behave as before there
 *   was one.
 * - `stale` — the observer stopped answering a moment ago: hold.
 * - `home`, `other` — no session is on screen.
 * - `session` with `sessionID`.
 */
export function readForeground(dir, now = Date.now(), pid = process.pid) {
  let record;
  try {
    record = JSON.parse(readFileSync(join(dir, FOREGROUND_FILE), "utf8"));
  } catch {
    return { kind: "unknown" };
  }
  if (record?.pid !== pid || typeof record.at !== "number") return { kind: "unknown" };
  const age = now - record.at;
  if (age > DEAD_MS) return { kind: "unknown" };
  if (age > STALE_MS) return { kind: "stale" };
  if (record.route === "session" && typeof record.sessionID === "string" && record.sessionID) {
    return { kind: "session", sessionID: record.sessionID };
  }
  if (record.route === "home") return { kind: "home" };
  return { kind: "other" };
}

const keyOf = (state) => `${state.kind}\0${state.sessionID ?? ""}`;

/**
 * Call `onChange(state)` whenever what the TUI shows changes — not on every
 * heartbeat. Best-effort: with no watcher the pane simply never follows the
 * TUI, which is how it behaved before.
 */
export function watchForeground(dir, onChange) {
  let last;
  const look = () => {
    const state = readForeground(dir);
    const key = keyOf(state);
    if (key === last) return;
    last = key;
    onChange(state);
  };
  try {
    look();
    watch(dir, (_event, name) => {
      if (name === null || name === FOREGROUND_FILE) look();
    }).unref?.();
  } catch {
    // No watcher, no following — see above.
  }
}
