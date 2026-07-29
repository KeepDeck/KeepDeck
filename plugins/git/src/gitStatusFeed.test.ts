import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitStatus, PluginContext } from "@keepdeck/plugin-api";
import { setRuntime } from "./runtime";
import { gitStatusSnapshot, subscribeGitStatus } from "./gitStatusFeed";

const clean = (): GitStatus => ({
  branch: "main",
  detached: false,
  oid: "abc1234def",
  upstream: null,
  ahead: null,
  behind: null,
  entries: [],
});

function makeCtx() {
  const watchers = new Map<string, Set<() => void>>();
  const disposed: string[] = [];
  let fail: string | null = null;
  let refuseWatch: string | null = null;
  let hold: Promise<void> | null = null;
  const status = vi.fn(async (repo: string) => {
    // A read that only settles when the test says so — the window a close or
    // a fresh change can land in.
    if (hold) await hold;
    if (fail) throw new Error(fail);
    return { ...clean(), oid: repo };
  });
  const watch = vi.fn((repo: string, onChange: () => void) => {
    // The capability/scope gate throws for an undeclared capability or an
    // out-of-scope path.
    if (refuseWatch) throw new Error(refuseWatch);
    let set = watchers.get(repo);
    if (!set) {
      set = new Set();
      watchers.set(repo, set);
    }
    set.add(onChange);
    return {
      dispose: () => {
        disposed.push(repo);
        set!.delete(onChange);
      },
    };
  });
  const ctx = {
    services: { git: { status, watch }, fs: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
  return {
    ctx,
    status,
    watch,
    disposed,
    fire: (repo: string) => watchers.get(repo)?.forEach((cb) => cb()),
    failWith: (message: string | null) => {
      fail = message;
    },
    refuseWatchWith: (message: string | null) => {
      refuseWatch = message;
    },
    holdStatus: (until: Promise<void> | null) => {
      hold = until;
    },
  };
}

let git: ReturnType<typeof makeCtx>;
/** Every subscription this test made, so the file cleans up after itself —
 * the module exposes no reset, because in production a feed is closed only by
 * its last subscriber leaving. */
let open: Array<() => void>;

/** Subscribe and remember the unsubscribe. */
function sub(repo: string, listener: () => void = vi.fn()): () => void {
  const stop = subscribeGitStatus(repo, listener);
  open.push(stop);
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
  open = [];
  git = makeCtx();
  setRuntime(git.ctx);
});

afterEach(() => {
  for (const stop of open.splice(0)) stop();
  setRuntime(null);
  vi.useRealTimers();
});

/** Let the queued read resolve. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("gitStatusFeed", () => {
  it("opens one watch and one read for the first subscriber", async () => {
    sub("/repo");
    await settle();

    expect(git.status).toHaveBeenCalledTimes(1);
    expect(git.watch).toHaveBeenCalledTimes(1);
    expect(gitStatusSnapshot("/repo").status?.oid).toBe("/repo");
    expect(gitStatusSnapshot("/repo").version).toBe(1);
  });

  it("joins a second subscriber to the SETTLED snapshot — no second read, no cold version", async () => {
    sub("/repo");
    await settle();
    const settledVersion = gitStatusSnapshot("/repo").version;

    // The diff peek opening over the tab: same repo, already warm.
    const second = vi.fn();
    sub("/repo", second);
    await settle();

    // This is the regression: a private feed per mount read again and ticked
    // its own version 0 -> 1, which re-ran every effect keyed on it.
    expect(git.status).toHaveBeenCalledTimes(1);
    expect(git.watch).toHaveBeenCalledTimes(1);
    expect(gitStatusSnapshot("/repo").version).toBe(settledVersion);
    expect(second).not.toHaveBeenCalled();
  });

  it("keeps the feed alive while any subscriber remains, and disposes at the last", async () => {
    const stopTab = sub("/repo");
    const stopPeek = sub("/repo");
    await settle();

    // The dock closes: the tab goes, the peek stays.
    stopTab();
    expect(git.disposed).toEqual([]);
    git.fire("/repo");
    await settle(300);
    expect(git.status).toHaveBeenCalledTimes(2);

    stopPeek();
    expect(git.disposed).toEqual(["/repo"]);
    // Nothing is watching: a change reaches nobody.
    expect(gitStatusSnapshot("/repo").version).toBe(0);
  });

  it("separate repos keep separate feeds", async () => {
    sub("/one");
    sub("/two");
    await settle();

    expect(git.status).toHaveBeenCalledTimes(2);
    expect(gitStatusSnapshot("/one").status?.oid).toBe("/one");
    expect(gitStatusSnapshot("/two").status?.oid).toBe("/two");
  });

  it("publishes a failure AND bumps the version, so readers re-read", async () => {
    const notified = vi.fn();
    sub("/repo", notified);
    await settle();
    const before = gitStatusSnapshot("/repo").version;

    // The worktree is deleted under an open peek.
    git.failWith("no such path: /repo");
    git.fire("/repo");
    await settle(300);

    const now = gitStatusSnapshot("/repo");
    expect(now.error).toBe("no such path: /repo");
    expect(now.status).toBeNull();
    // Bumping on failure is what stops a peek showing hunks of a worktree
    // that is gone: its diff re-reads and reports the same failure.
    expect(now.version).toBe(before + 1);
    expect(notified).toHaveBeenCalled();
  });

  it("still serves reads when the watch is refused", async () => {
    git.refuseWatchWith("git watch not permitted for /repo");
    sub("/repo");
    await settle();

    // Not live, but not blank either: the read still happened.
    expect(git.status).toHaveBeenCalledTimes(1);
    expect(gitStatusSnapshot("/repo").status?.oid).toBe("/repo");
  });

  it("retries a refused watch on the next subscriber, and re-reads with it", async () => {
    git.refuseWatchWith("git watch not permitted for /repo");
    const stop = sub("/repo");
    await settle();
    expect(git.status).toHaveBeenCalledTimes(1);

    // A feed with no watcher will never re-read itself and there is no
    // refresh button by design — so a new subscriber has to be the retry.
    // Without it, one refused watch froze this repo for the session.
    git.refuseWatchWith(null);
    sub("/repo");
    await settle();

    expect(git.status).toHaveBeenCalledTimes(2);
    // And it is live again: a change now reaches the feed.
    git.fire("/repo");
    await settle(300);
    expect(git.status).toHaveBeenCalledTimes(3);
    stop();
  });

  it("does NOT re-read for a second subscriber when the feed IS live", async () => {
    sub("/repo");
    await settle();
    expect(git.status).toHaveBeenCalledTimes(1);

    // The retry must not undo the whole point of sharing the feed.
    sub("/repo");
    await settle();
    expect(git.status).toHaveBeenCalledTimes(1);
  });

  it("drops a read that lands after its feed was closed", async () => {
    // Hold the read open, then let the last subscriber go while it is still
    // in flight — the dock closing on a slow repo.
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    git.holdStatus(held);

    const stop = sub("/repo");
    stop();
    expect(git.disposed).toEqual(["/repo"]);

    release();
    await settle();

    // The late result must not publish into a feed nobody is watching, and
    // must not resurrect it.
    expect(gitStatusSnapshot("/repo")).toEqual({
      status: null,
      error: null,
      version: 0,
    });
  });

  it("coalesces a change that lands mid-read into exactly one re-read", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    git.holdStatus(held);
    sub("/repo");
    expect(git.status).toHaveBeenCalledTimes(1);

    // Two changes while the first read is still running: single-flight marks
    // the feed dirty rather than queueing a pile-up.
    git.fire("/repo");
    await settle(300);
    git.fire("/repo");
    await settle(300);
    expect(git.status).toHaveBeenCalledTimes(1);

    release();
    await settle();
    expect(git.status).toHaveBeenCalledTimes(2);
    expect(gitStatusSnapshot("/repo").status?.oid).toBe("/repo");
  });

  it("debounces a burst of watch events into one re-read", async () => {
    sub("/repo");
    await settle();
    expect(git.status).toHaveBeenCalledTimes(1);

    git.fire("/repo");
    git.fire("/repo");
    git.fire("/repo");
    await settle(299);
    expect(git.status).toHaveBeenCalledTimes(1);

    await settle(2);
    expect(git.status).toHaveBeenCalledTimes(2);
  });

  it("survives a runtime that is gone — no unhandled rejection, no latched read", async () => {
    sub("/repo");
    await settle();

    // Teardown order: deactivate nulls the runtime before React unmounts the
    // surfaces, so a queued read can land in the gap.
    setRuntime(null);
    git.fire("/repo");
    await settle(300);

    // The failure was caught and published, and the feed is not wedged: a
    // later read still runs once the runtime is back.
    expect(gitStatusSnapshot("/repo").error).toContain("runtime");
    setRuntime(git.ctx);
    git.fire("/repo");
    await settle(300);
    expect(gitStatusSnapshot("/repo").status).not.toBeNull();
  });
});
