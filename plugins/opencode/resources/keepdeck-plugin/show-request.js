/**
 * A request to show a session, from the server half of KeepDeck's opencode
 * 2.x plugin to its TUI half (task-436).
 *
 * On 1.x the server plugin can select a session itself (`tui.session.select`
 * on the client). The 2.x server plugin has no TUI navigation; the TUI plugin
 * (tui.js) has `ui.router.navigate`. So the courier writes the session it
 * made for mail here, and the TUI half shows it — the same bridge directory
 * the screen is reported through, the other way round.
 *
 * The record: `{ sessionID, at }`, written atomically. A request is taken
 * once — read and removed — and only while it is fresh: one the TUI did not
 * get to in time belongs to a moment that has passed, and the courier has
 * already given up on it.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SHOW_FILE = "show.json";

/** Older than this, a request is not obeyed: the courier waits as long for
 * the session to come on screen. */
export const SHOW_FRESH_MS = 3_000;

/** Ask the TUI half to show `sessionID`. */
export function requestShow(dir, sessionID, now = Date.now()) {
  const path = join(dir, SHOW_FILE);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ sessionID, at: now }));
  renameSync(tmp, path);
}

/** The session asked to be shown, taken off disk — or null when there is no
 * fresh, well-formed request. A stale or broken one is removed all the same. */
export function takeShowRequest(dir, now = Date.now()) {
  const path = join(dir, SHOW_FILE);
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    record = null;
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // Left on disk, it is read again — and refused once it is stale.
  }
  if (typeof record?.sessionID !== "string" || !record.sessionID) return null;
  if (typeof record.at !== "number" || now - record.at > SHOW_FRESH_MS) return null;
  return record.sessionID;
}
