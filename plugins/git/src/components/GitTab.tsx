import { useRef, useState } from "react";
import type { DockTabProps } from "@keepdeck/plugin-api";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import { shortPath } from "@keepdeck/ui-kit/paths";
import { useGitStatus } from "./useGitStatus";
import { groupEntries, headline, type ChangeRow } from "../domain/status";
import { FileSection } from "./FileRows";
import { HistoryView } from "./HistoryView";
import { requestPeek } from "../peekRequests";
import { BranchIcon } from "../icons";

/**
 * The Git tab: a live changes view of the chosen repo. The root is a pane's
 * worktree or the workspace folder, defaulting to the highlighted pane's
 * worktree — "show what I'm looking at" — and following the highlight like the
 * Files tab's root; a manual pick holds until the next pane click.
 *
 * Everything updates by itself: the git watch (edits, staging, commits,
 * checkouts) feeds `useGitStatus`, which is why there is no refresh button
 * anywhere.
 *
 * Opening a row or a history scope HANDS the diff to the plugin's resident
 * overlay (`GitDiffOverlay`) instead of rendering it here. A peek rendered in
 * a tab body is hidden with it on a tab switch and unmounted with it when the
 * dock closes; the diff belongs to neither. The tab therefore also does not
 * close an open diff when its own root changes — that diff is pinned to the
 * repo it was opened on and stays live against it, rather than vanishing from
 * under the reader because something re-rooted the panel behind it.
 */
export function GitTab({ workspace, selectedPaneId }: DockTabProps) {
  const [target, setTarget] = useState(
    () =>
      workspace.panes.find((pane) => pane.id === selectedPaneId)?.cwd ??
      workspace.cwd,
  );
  // Follow the highlighted pane (same seen-ref idiom as the Files tab).
  const seenSelectedRef = useRef(selectedPaneId);
  if (seenSelectedRef.current !== selectedPaneId) {
    seenSelectedRef.current = selectedPaneId;
    const followed = workspace.panes.find(
      (pane) => pane.id === selectedPaneId,
    )?.cwd;
    if (followed && followed !== target) setTarget(followed);
  }

  const { status, error, version } = useGitStatus(target);
  const [mode, setMode] = useState<"changes" | "history">("changes");

  // Distinct roots: each pane worktree once, the workspace folder last (a
  // pane attached to the main repo can't duplicate it).
  const targets = [
    ...[
      ...new Map(
        workspace.panes
          .filter((pane) => pane.cwd && pane.cwd !== workspace.cwd)
          .map((pane) => [
            pane.cwd!,
            // Branch AND folder — the picker chooses working trees, not
            // branches — but stacked: a 340px dock can't fit them inline.
            // The folder line shows in the OPEN list only (CSS hides it on
            // the closed control, same rule as the ref picker's check).
            pane.branch ? (
              <span className="git__rootopt" title={pane.cwd}>
                <span className="git__rootbranch">{pane.branch}</span>
                <span className="git__rootfolder">{lastSegment(pane.cwd!)}</span>
              </span>
            ) : (
              shortPath(pane.cwd!)
            ),
          ]),
      ).entries(),
    ].map(([value, label]) => ({ value, label })),
    { value: workspace.cwd, label: "Workspace folder" },
  ];

  const groups = status ? groupEntries(status.entries) : null;
  // The workspace rides along so the peek can outlive the dock without
  // outliving the workspace it was opened in.
  const subject = { id: workspace.id, instance: workspace.instance };
  const openRow = (row: ChangeRow) =>
    requestPeek({ repo: target, workspace: subject, kind: "worktree", row });

  return (
    <div className="git">
      <div className="git__bar">
        <Dropdown
          className="git__root"
          options={targets}
          value={target}
          onChange={setTarget}
          ariaLabel="Repository to show changes for"
        />
      </div>

      <div className="git__mode" role="group" aria-label="View">
        <button
          type="button"
          className={`git__modebtn${mode === "changes" ? " git__modebtn--on" : ""}`}
          onClick={() => setMode("changes")}
          aria-pressed={mode === "changes"}
        >
          Changes
        </button>
        <button
          type="button"
          className={`git__modebtn${mode === "history" ? " git__modebtn--on" : ""}`}
          onClick={() => setMode("history")}
          aria-pressed={mode === "history"}
        >
          History
        </button>
      </div>

      {status && (
        <div className="git__head">
          <span className="git__bicon">
            <BranchIcon />
          </span>
          <span className="git__branch" title={headline(status)}>
            {headline(status)}
          </span>
          {status.upstream && (
            <span
              className="git__ab"
              title={`${status.ahead ?? 0} ahead, ${status.behind ?? 0} behind ${status.upstream}`}
            >
              ↑{status.ahead ?? 0} ↓{status.behind ?? 0}
            </span>
          )}
          {groups && groups.total > 0 && (
            <span className="git__count">{groups.total}</span>
          )}
        </div>
      )}

      <div
        className="git__list"
        role="list"
        aria-label={mode === "changes" ? "Working tree changes" : "History"}
      >
        {mode === "history" ? (
          <HistoryView
            repo={target}
            version={version}
            onOpen={(scope) =>
              requestPeek({
                repo: target,
                workspace: subject,
                kind: "history",
                scope,
              })
            }
          />
        ) : (
          <>
            {!status && !error && <div className="git__empty">Loading…</div>}
            {error && <div className="git__empty git__empty--bad">{error}</div>}
            {groups && groups.total === 0 && (
              <div className="git__empty">No changes — the tree is clean.</div>
            )}
            {groups && (
              <>
                <FileSection
                  label="Conflicts"
                  rows={groups.conflicted}
                  onOpen={openRow}
                />
                <FileSection
                  label="Staged"
                  rows={groups.staged}
                  onOpen={openRow}
                />
                <FileSection
                  label="Changes"
                  rows={groups.unstaged}
                  onOpen={openRow}
                />
                <FileSection
                  label="Untracked"
                  rows={groups.untracked}
                  onOpen={openRow}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The folder's own name. */
function lastSegment(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
