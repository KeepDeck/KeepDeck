import { useEffect, useState } from "react";
import type { WorkspaceRef } from "@keepdeck/plugin-api";
import { DiffPeek } from "./DiffPeek";
import { useGitStatus } from "./useGitStatus";
import { groupEntries, type ChangeRow } from "../domain/status";
import type { HistoryScope } from "../domain/history";
import { getRuntime } from "../runtime";
import { subscribePeekRequests, takePeekRequest } from "../peekRequests";

/**
 * The open diff. Splitting the union keeps a null-row worktree
 * unrepresentable: a Changes row is always picked before it opens, while a
 * History scope opens first and the peek's rail seeds its file after.
 *
 * `repo` is the peek's OWN — captured when the diff was opened, not read from
 * the tab. The two are independent on purpose: see the overlay below.
 */
type OpenDiff = { repo: string; workspace: WorkspaceRef } & (
  | { kind: "worktree"; row: ChangeRow }
  | { kind: "history"; row: ChangeRow | null; scope: HistoryScope }
);

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
      if (!next) return;
      const { repo, workspace } = next;
      // A History scope opens with no file yet; a Changes row opens on itself.
      setDiff(
        next.kind === "worktree"
          ? { repo, workspace, kind: "worktree", row: next.row }
          : { repo, workspace, kind: "history", row: null, scope: next.scope },
      );
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
  // naming where it came from.
  useEffect(() => {
    const { events } = getRuntime();
    const gone = (workspace: WorkspaceRef) =>
      setDiff((prev) =>
        prev && prev.workspace.instance === workspace.instance ? null : prev,
      );
    // Fires for the ACTIVE workspace, so a different one named here means the
    // user moved: the open diff belongs to the workspace they left.
    const selected = events.onPaneSelected(({ workspace }) =>
      setDiff((prev) =>
        prev && prev.workspace.instance !== workspace.instance ? null : prev,
      ),
    );
    const closed = events.onWorkspaceClosed(({ workspace }) => gone(workspace));
    return () => {
      selected.dispose();
      closed.dispose();
    };
  }, []);

  if (!diff) return null;
  return (
    <OpenDiffPeek
      // A diff of another repo is a different subject, not the same peek
      // re-pointed: remount so nothing of the old one's fetch state carries.
      key={diff.repo}
      diff={diff}
      onSelect={(row) => setDiff((prev) => (prev ? { ...prev, row } : prev))}
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

  return (
    <DiffPeek
      repo={diff.repo}
      view={
        diff.kind === "worktree"
          ? {
              kind: "file",
              row: diff.row,
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
      version={version}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}
