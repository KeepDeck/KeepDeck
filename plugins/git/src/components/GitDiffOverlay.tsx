import { useEffect, useState } from "react";
import { DiffPeek } from "./DiffPeek";
import { useGitStatus } from "./useGitStatus";
import { groupEntries, reconcileRow, type ChangeRow } from "../domain/status";
import { readVersionFor } from "../domain/history";
import {
  afterClose,
  afterSelection,
  openDiffFor,
  withRow,
  type OpenDiff,
} from "../domain/openDiff";
import { activeRuntime } from "../runtime";
import { subscribePeekRequests, takePeekRequest } from "../peekRequests";

/**
 * The plugin's resident diff viewer — the single consumer of the tab's peek
 * requests. Registered as a host overlay, so it lives for as long as the
 * plugin is active regardless of what the dock is doing: switching to another
 * dock tab no longer hides an open diff, and closing the dock no longer
 * destroys it. Empty until a request arrives.
 *
 * It also keeps a full-window overlay OUT of the dock's subtree, which is
 * what let the dock be a plain panel again — `.peek` is `position: fixed`
 * with a window-level z-index, and a fixed descendant is only ever as
 * window-level as its ancestors allow.
 */
export function GitDiffOverlay() {
  const [diff, setDiff] = useState<OpenDiff | null>(null);

  useEffect(() => {
    const consume = () => {
      const next = takePeekRequest();
      if (next) setDiff(openDiffFor(next));
    };
    // A request may predate this mount; the take-based consume is naturally
    // StrictMode-safe — a re-invoked effect finds the slot empty and touches
    // nothing.
    consume();
    return subscribePeekRequests(consume);
  }, []);

  // The diff outlives the dock, but not its subject. Being resident, this
  // overlay is never remounted by a workspace change the way the dock panel
  // is — so without these it kept a full-window diff of the workspace the
  // user just left on screen over the one they went to, with nothing on it
  // naming where it came from. Which event takes it down is the domain's
  // rule (`afterSelection`, `afterClose`).
  useEffect(() => {
    // Torn down: nothing left to listen to (and this mounts once anyway).
    const runtime = activeRuntime();
    if (!runtime) return;
    const { events } = runtime;
    const selected = events.onPaneSelected(({ workspace }) =>
      setDiff((prev) => prev && afterSelection(prev, workspace)),
    );
    const closed = events.onWorkspaceClosed(({ workspace }) =>
      setDiff((prev) => prev && afterClose(prev, workspace)),
    );
    return () => {
      selected.dispose();
      closed.dispose();
    };
  }, []);

  // The host cannot see a full-window peek by itself — a Component overlay
  // is "visible" while it renders nothing — so the peek says when it covers
  // the deck and when it stops: the deck's hotkeys pause behind it, and a
  // pane under it is not on screen for a notification. Unsaid on unmount
  // too, so a plugin torn down mid-peek leaves the deck unpaused. The
  // runtime may already be gone on that path; the host clears a retired
  // plugin's cover on its own, so there is nothing to tell then.
  const covers = diff !== null;
  useEffect(() => {
    const say = (value: boolean) =>
      activeRuntime()?.ui.setOverlayCovers("diff", value);
    say(covers);
    return () => {
      if (covers) say(false);
    };
  }, [covers]);

  if (!diff) return null;
  return (
    <OpenDiffPeek
      // A diff of another repo is a different subject, not the same peek
      // re-pointed: remount so it starts on the new repo's own status feed
      // rather than re-subscribing mid-life. It is NOT what keeps stale
      // content out — every list and fetch below carries the change set it
      // belongs to, which is what makes switching scopes within one repo
      // safe too.
      key={diff.repo}
      diff={diff}
      onSelect={(row) => setDiff((prev) => prev && withRow(prev, row))}
      onClose={() => setDiff(null)}
    />
  );
}

/**
 * One open diff, live against its own repo. It subscribes to the repo's
 * status in its own right rather than borrowing the tab's: the peek needs the
 * change list for its rail and a `version` to re-read on, with the dock in any
 * state — including closed, where there is no tab to supply them.
 *
 * Subscribing is not the same as owning. Both surfaces read the one feed
 * `gitStatusFeed` keeps per repo, so the peek opens at whatever the tab had
 * already settled on: no second read, no cold `version` transition, and one
 * answer to "what changed" instead of two that drift.
 */
function OpenDiffPeek({
  diff,
  onSelect,
  onClose,
}: {
  diff: OpenDiff;
  onSelect: (row: ChangeRow) => void;
  onClose: () => void;
}) {
  const { status, error, version } = useGitStatus(diff.repo);
  const groups = status ? groupEntries(status.entries) : null;
  // What the peek re-reads on: the feed's tick, frozen for a commit scope
  // while the feed is healthy — a commit cannot move, a deleted repo can.
  const readVersion = readVersionFor(diff.kind === "history" ? diff.scope : null, {
    version,
    error,
  });
  // A worktree row follows its file across the live groups: staged under
  // the open peek, it shows the staged diff next, not an empty re-read of
  // the worktree one. Derived per tick, so the row the overlay holds is
  // only where the peek was opened, never a frozen classification.
  const worktreeRow =
    diff.kind === "worktree" && groups ? reconcileRow(diff.row, groups) : diff.row;

  return (
    <DiffPeek
      repo={diff.repo}
      view={
        diff.kind === "worktree"
          ? {
              kind: "file",
              row: worktreeRow!,
              changeSet: { kind: "worktree", groups, error },
            }
          : diff.row !== null
            ? {
                kind: "file",
                row: diff.row,
                changeSet: { kind: "history", scope: diff.scope },
              }
            : { kind: "waiting", scope: diff.scope }
      }
      version={readVersion}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}
