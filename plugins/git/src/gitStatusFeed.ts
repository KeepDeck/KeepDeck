import type { Disposable, GitStatus } from "@keepdeck/plugin-api";
import { getRuntime } from "./runtime";

/**
 * One live status feed per repo, shared by every surface that watches it.
 *
 * The feed is the OWNER of a repo's status: it holds the watch subscription,
 * the debounce, the single-flight read and the current snapshot, and it
 * outlives any one component's mount. Surfaces subscribe; the last one to
 * leave disposes the watch.
 *
 * That ownership is the point. When each mount owned its own feed, a second
 * surface on the same repo started COLD — its `version` began at 0 and ticked
 * to 1 once the first read landed, which re-ran every effect keyed on it, so
 * opening a diff cost two `diffFile` reads and painted a frame with no file
 * rail. Sharing one feed means the second subscriber joins at the settled
 * snapshot and sees no transition at all.
 *
 * `version` bumps on EVERY resolved read, success or failure. Consumers
 * re-read on it, and a failure they never hear about is how a peek kept
 * showing the hunks of a worktree that had already been deleted.
 */

export interface GitStatusSnapshot {
  status: GitStatus | null;
  error: string | null;
  /** Revision of this feed; bumps on every resolved read. */
  version: number;
}

/** Watch events are debounced (trailing edge) so a build's thousand writes
 * become one re-read after the dust settles. */
const WATCH_DEBOUNCE_MS = 300;

const EMPTY: GitStatusSnapshot = { status: null, error: null, version: 0 };

interface Feed {
  snapshot: GitStatusSnapshot;
  readonly listeners: Set<() => void>;
  watcher: Disposable | null;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
  dirty: boolean;
}

const feeds = new Map<string, Feed>();

/** Live only while `feeds` still holds it — a late read from a disposed feed
 * must not publish into a snapshot nobody is watching. */
function alive(repo: string, feed: Feed): boolean {
  return feeds.get(repo) === feed;
}

function publish(repo: string, feed: Feed, next: GitStatusSnapshot): void {
  if (!alive(repo, feed)) return;
  feed.snapshot = next;
  // A copy: a listener may unsubscribe (or subscribe) while being notified.
  for (const listener of [...feed.listeners]) listener();
}

async function load(repo: string, feed: Feed): Promise<void> {
  if (feed.inflight) {
    // A change during an in-flight read re-reads once at the end rather than
    // queueing a pile-up.
    feed.dirty = true;
    return;
  }
  feed.inflight = true;
  try {
    // INSIDE the try: after a deactivate this throws, and outside it the
    // rejection escaped unhandled and left `inflight` latched forever.
    const { services } = getRuntime();
    const status = await services.git.status(repo);
    publish(repo, feed, {
      status,
      error: null,
      version: feed.snapshot.version + 1,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    warn(`git status failed for ${repo}: ${message}`);
    publish(repo, feed, {
      status: null,
      error: message,
      version: feed.snapshot.version + 1,
    });
  } finally {
    feed.inflight = false;
    if (feed.dirty && alive(repo, feed)) {
      feed.dirty = false;
      void load(repo, feed);
    }
  }
}

/** Logging must never be the thing that throws: the runtime is gone exactly
 * in the teardown paths this reports on. */
function warn(message: string): void {
  try {
    getRuntime().log.warn(message);
  } catch {
    // The plugin is torn down; there is nowhere left to say it.
  }
}

/** Put `feed` under the repo's watch. Leaves `watcher` null if the backend
 * refuses — the feed still serves reads, it just isn't live, which is the
 * state `subscribeGitStatus` retries out of. */
function startWatch(repo: string, feed: Feed): void {
  try {
    const { services } = getRuntime();
    feed.watcher = services.git.watch(repo, () => {
      if (feed.timer) clearTimeout(feed.timer);
      feed.timer = setTimeout(() => {
        feed.timer = null;
        void load(repo, feed);
      }, WATCH_DEBOUNCE_MS);
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    warn(`git watch failed for ${repo}: ${message}`);
  }
}

function open(repo: string): Feed {
  const feed: Feed = {
    snapshot: EMPTY,
    listeners: new Set(),
    watcher: null,
    timer: null,
    inflight: false,
    dirty: false,
  };
  feeds.set(repo, feed);
  void load(repo, feed);
  startWatch(repo, feed);
  return feed;
}

function close(repo: string, feed: Feed): void {
  if (!alive(repo, feed)) return;
  feeds.delete(repo);
  feed.watcher?.dispose();
  feed.watcher = null;
  if (feed.timer) clearTimeout(feed.timer);
  feed.timer = null;
}

/** Subscribe to `repo`'s status; returns the unsubscribe. The first
 * subscriber opens the feed, the last one to leave disposes it. */
export function subscribeGitStatus(repo: string, listener: () => void): () => void {
  let feed = feeds.get(repo);
  if (!feed) {
    feed = open(repo);
  } else if (!feed.watcher) {
    // The feed exists but is NOT live: its watch was refused when it opened,
    // so nothing will ever re-read it and there is deliberately no refresh
    // button anywhere. A new subscriber is the only retry there is — which is
    // what the per-mount hook this replaced did implicitly, by loading every
    // time a surface mounted. Without this, one refused watch froze the repo's
    // status for the rest of the session and re-opening the tab read nothing.
    startWatch(repo, feed);
    void load(repo, feed);
  }
  feed.listeners.add(listener);
  return () => {
    feed.listeners.delete(listener);
    if (feed.listeners.size === 0) close(repo, feed);
  };
}

/** The repo's current snapshot — a stable reference between changes, so it
 * can back `useSyncExternalStore` directly. */
export function gitStatusSnapshot(repo: string): GitStatusSnapshot {
  return feeds.get(repo)?.snapshot ?? EMPTY;
}

/** Drop every feed. The plugin's `deactivate` calls this: a feed holds a
 * watch subscription and a pending timer, and both belong to the activation
 * that opened them. */
export function closeAllGitStatusFeeds(): void {
  for (const [repo, feed] of [...feeds]) close(repo, feed);
}
