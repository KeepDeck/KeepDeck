/**
 * What the pane's TUI is showing, shared between the TUI half and the server
 * half of KeepDeck's opencode plugin, on either generation (task-435,
 * task-436).
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
 * opencode 2.x splits the two halves across PROCESSES instead: the TUI
 * spawns `opencode serve` as its child, and the server plugin runs there
 * (measured on 2.1.2, task-436). The same file is the channel; what differs
 * is whose pid a trusted record carries — the reader names it (`owner`).
 *
 * The record: `{ route: "home" | "session" | "other", sessionID?, pid, at }`.
 * Rewritten on every change and once a second as a heartbeat, atomically.
 */
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FOREGROUND_FILE = "foreground.json";

/** How often the observer reads the TUI's route: neither opencode
 * generation tells a plugin the route changed (task-435, task-436). */
export const POLL_MS = 250;
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
 * What the TUI is showing, as far as this process can trust it. `owner` is
 * the pid of the TUI process this one serves — its own on 1.x, its parent on
 * 2.x:
 *
 * - `unknown` — no observer is running for that TUI (no file, another
 *   process's file, or one that stopped long ago): behave as before there
 *   was one.
 * - `stale` — the observer stopped answering a moment ago: hold.
 * - `home`, `other` — no session is on screen.
 * - `session` with `sessionID`.
 */
export function readForeground(dir, now = Date.now(), owner = process.pid) {
  let record;
  try {
    record = JSON.parse(readFileSync(join(dir, FOREGROUND_FILE), "utf8"));
  } catch {
    return { kind: "unknown" };
  }
  if (record?.pid !== owner || typeof record.at !== "number") return { kind: "unknown" };
  const age = now - record.at;
  if (age > DEAD_MS) return { kind: "unknown" };
  if (age > STALE_MS) return { kind: "stale" };
  if (record.route === "session" && typeof record.sessionID === "string" && record.sessionID) {
    return { kind: "session", sessionID: record.sessionID };
  }
  if (record.route === "home") return { kind: "home" };
  return { kind: "other" };
}

const same = (a, b) => a?.route === b?.route && a?.sessionID === b?.sessionID;

/**
 * The TUI half's watch, for either generation's TUI plugin: poll `read()` —
 * the route as the server half reads it, `{ route, sessionID? }` — and write
 * it down. Returns the stop.
 *
 * A route is written once it held for two polls in a row, so a screen the
 * TUI only passes through is not reported as somewhere the user went; an
 * unchanged one is rewritten once a heartbeat. A read that throws skips the
 * poll, and a write that fails is dropped: a pane whose route cannot be
 * written behaves as before.
 */
export function observeRoute(read, dir, now = () => Date.now()) {
  let seen; // the last route read
  let held; // the route last written
  let writtenAt = 0;
  const poll = () => {
    let route;
    try {
      route = read();
    } catch {
      return;
    }
    const steady = same(route, seen);
    seen = route;
    const changed = steady && !same(route, held);
    if (!changed && (held === undefined || now() - writtenAt < HEARTBEAT_MS)) return;
    if (changed) held = route;
    try {
      writtenAt = now();
      writeForeground(dir, held, writtenAt);
    } catch {
      // Best-effort, as above.
    }
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

const keyOf = (state) => `${state.kind}\0${state.sessionID ?? ""}`;

/**
 * Call `onChange(state)` whenever what the TUI shows changes — not on every
 * heartbeat. Best-effort: with no watcher the pane simply never follows the
 * TUI, which is how it behaved before.
 *
 * ANY event in the directory triggers a read, not only one naming the file:
 * Bun on macOS reports the observer's atomic write as a rename of its TMP
 * name alone (measured live, task-443) — filtering on the final name left
 * the follower deaf. Reading is cheap and deduplicated by the key. And it
 * is read once a heartbeat regardless: a TUI that stops writing produces no
 * event at all, yet it turns the route stale, then unknown.
 *
 * Returns the stop: opencode 2.x reloads a plugin in place, and a watch left
 * running would follow the screen twice.
 */
export function watchForeground(dir, onChange, owner = process.pid) {
  let last;
  const look = () => {
    const state = readForeground(dir, Date.now(), owner);
    const key = keyOf(state);
    if (key === last) return;
    last = key;
    onChange(state);
  };
  look();
  const timer = setInterval(look, HEARTBEAT_MS);
  timer.unref?.();
  let watcher;
  try {
    watcher = watch(dir, look);
    watcher.unref?.();
  } catch {
    // No watcher: the heartbeat read still follows, a second later.
  }
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}
