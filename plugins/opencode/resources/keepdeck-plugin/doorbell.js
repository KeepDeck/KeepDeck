/**
 * The deck's doorbell (bridge/nudge.rs): `mail.wake` in the pane's own inbox
 * directory, rung when mail waits for an idle pane and nothing else was going
 * to happen. Shared by both opencode generations' couriers.
 *
 * The file carries nothing — everything about the mail is in the answer to
 * the courier's ask — so taking it down IS reading it.
 */
import { existsSync, rmSync, watch } from "node:fs";
import { join } from "node:path";

/** Call `onRing` once per ring, taking each down. Returns the stop. */
export function watchDoorbell(dir, onRing) {
  // `dir` is this pane's OWN inbox, so the doorbell needs no name of its own
  // — there is only ever one pane's worth of traffic in here.
  const path = join(dir, "mail.wake");
  const take = () => {
    try {
      if (!existsSync(path)) return;
      rmSync(path, { force: true });
    } catch {
      return;
    }
    onRing();
  };
  let watcher;
  try {
    // A ring that landed before this process was watching — a pane still
    // booting when the deck rang — is still on disk. Nobody re-sends it.
    take();
    // Unref'd: a watcher is background work, and it has no business being
    // the last thing keeping an exiting process alive.
    watcher = watch(dir, () => take());
    watcher.unref?.();
  } catch {
    // No watcher: the pane still gets its mail at every turn boundary and
    // every prompt the user sends. Only the idle case is lost.
  }
  return () => watcher?.close();
}
