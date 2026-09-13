import type { DockTabProps } from "@keepdeck/plugin-api";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import { useRootSelection } from "@keepdeck/ui-kit/useRootSelection";
import { useGitStatus } from "./useGitStatus";
import { useGitHistory } from "./useGitHistory";
import { useSections } from "./useSections";
import { groupEntries, type ChangeRow } from "../domain/status";
import { rootFacts } from "../domain/roots";
import { rootOptions } from "../presentation/rootOptionView";
import { changesHead } from "../presentation/changesHeadView";
import { FileSection } from "./FileRows";
import { HistoryView } from "./HistoryView";
import { Section } from "./Section";
import { requestPeek } from "../peekRequests";

/**
 * The Git tab: the root picker on top, and under it two sections that open
 * and close — Changes, the live working tree, and History, the log since
 * the fork point. The root is a team's worktree or the workspace folder,
 * defaulting to the highlighted pane's — "show what I'm looking at" — and
 * following the highlight like the Files tab's root; a manual pick holds
 * until the highlight changes (`useRootSelection`).
 *
 * Everything updates by itself: the git watch (edits, staging, commits,
 * checkouts) feeds `useGitStatus`, which is why there is no refresh button
 * anywhere. History is read only while its section is open, and keeps its
 * window across a collapse.
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
  // One option per repository, named by the team whose tree it is. Stacked:
  // a 340px dock can't fit team, branch and folder inline, so the folder
  // line shows in the OPEN list only (CSS hides it on the closed control,
  // same rule as the ref picker's check).
  const options = rootOptions(rootFacts(workspace));
  const [target, pick] = useRootSelection({
    selectedPaneId,
    panes: workspace.panes,
    fallback: workspace.cwd,
    roots: options.map((option) => option.value),
  });
  const targets = options.map((option) => ({
    value: option.value,
    label:
      option.detail === undefined && option.folder === undefined ? (
        option.title
      ) : (
        <span className="git__rootopt" title={option.hint}>
          <span className="git__rootline">
            <span className="git__rootteam">{option.title}</span>
            {option.detail && <span className="git__rootbranch">{option.detail}</span>}
          </span>
          {option.folder && <span className="git__rootfolder">{option.folder}</span>}
        </span>
      ),
  }));

  const { status, error, version } = useGitStatus(target);
  const [sections, toggle] = useSections(workspace);
  const groups = status ? groupEntries(status.entries) : null;
  const head = changesHead(status, groups);
  const log = useGitHistory(target, version, sections.history);

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
          onChange={pick}
          ariaLabel="Repository to show changes for"
        />
      </div>

      <div className="git__sections">
        <Section
          id="changes"
          label="Changes"
          count={head.count}
          open={sections.changes}
          onToggle={toggle}
          aside={
            head.upstream && (
              <span
                className="git__ab"
                title={`${head.upstream.ahead} ahead, ${head.upstream.behind} behind ${head.upstream.name}`}
              >
                ↑{head.upstream.ahead} ↓{head.upstream.behind}
              </span>
            )
          }
        >
          {!status && !error && <div className="git__empty">Loading…</div>}
          {error && <div className="git__empty git__empty--bad">{error}</div>}
          {groups && groups.total === 0 && (
            <div className="git__empty">No changes — the tree is clean.</div>
          )}
          {groups && (
            <>
              <FileSection label="Conflicts" rows={groups.conflicted} onOpen={openRow} />
              <FileSection label="Staged" rows={groups.staged} onOpen={openRow} />
              <FileSection label="Changes" rows={groups.unstaged} onOpen={openRow} />
              <FileSection label="Untracked" rows={groups.untracked} onOpen={openRow} />
            </>
          )}
        </Section>

        <Section
          id="history"
          label="History"
          count={log.history?.ahead ?? null}
          open={sections.history}
          onToggle={toggle}
        >
          <HistoryView
            history={log.history}
            error={log.error}
            hasMore={log.hasMore}
            loadMore={log.loadMore}
            onOpen={(scope) =>
              requestPeek({ repo: target, workspace: subject, kind: "history", scope })
            }
          />
        </Section>
      </div>
    </div>
  );
}
