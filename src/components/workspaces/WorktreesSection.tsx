import { useEffect, useState } from "react";
import type { RepoCheckout, UnheldRemoval, UnheldRemovalRequest, Workspace } from "../../domain/deck";
import {
  unheldRemovalWords,
  WORKTREE_WORDS,
  worktreeRemovalConfirm,
  worktreeTableView,
} from "../../presentation/worktreeTableView";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

export interface WorktreesSectionProps {
  workspace: Workspace;
  workspaces: readonly Workspace[];
  listWorktrees(repo: string): Promise<RepoCheckout[]>;
  onRemove(request: UnheldRemovalRequest): Promise<UnheldRemoval>;
  /** Make a new team in a worktree of its own — the "+ Team" door. Null
   * while the workspace cannot take one (archived). */
  onNewTeam: (() => void) | null;
}

/**
 * The page's Worktrees: every checkout of the workspace's repository, who
 * holds it, what is in it — and Remove for one nobody holds, behind a
 * confirm that says what goes and what stays. Reads the list when the page
 * opens and again after a removal; decides nothing it can hand to the view.
 */
export function WorktreesSection({ workspace, workspaces, listWorktrees, onRemove, onNewTeam }: WorktreesSectionProps) {
  const [listed, setListed] = useState<RepoCheckout[] | "loading" | "none">("loading");
  const [reads, setReads] = useState(0);
  const [asked, setAsked] = useState<RepoCheckout | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const repo = workspace.cwd;

  useEffect(() => {
    let current = true;
    listWorktrees(repo).then(
      (rows) => current && setListed(rows),
      () => current && setListed("none"),
    );
    return () => {
      current = false;
    };
  }, [listWorktrees, repo, reads]);

  const table = Array.isArray(listed) ? worktreeTableView(listed, workspace, workspaces) : null;
  const confirm = asked ? worktreeRemovalConfirm(asked, workspace, Date.now()) : null;

  return (
    <section className="workspaces__sec">
      <h4>
        {WORKTREE_WORDS.title}
        {Array.isArray(listed) && <span className="workspaces__count">{listed.length}</span>}
        {onNewTeam && (
          <span className="workspaces__sec-act">
            <Button size="sm" variant="ghost" onClick={onNewTeam}>
              {WORKTREE_WORDS.newTeam}
            </Button>
          </span>
        )}
      </h4>
      {listed === "loading" && <span className="settings__hint">{WORKTREE_WORDS.loading}</span>}
      {listed === "none" && <span className="settings__hint">{WORKTREE_WORDS.notARepo}</span>}
      {table && (
        <table className="workspaces__worktrees">
          <tbody>
            {table.rows.map((row, at) => (
              <tr key={row.path}>
                <td className="workspaces__wt-path" title={row.path}>
                  {row.path}
                </td>
                <td>{row.branch}</td>
                <td>{row.state}</td>
                <td>{row.holder}</td>
                <td>
                  {row.removable && Array.isArray(listed) && (
                    <button type="button" className="form__dir-btn" onClick={() => setAsked(listed[at])}>
                      {WORKTREE_WORDS.remove}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span className="settings__hint">{WORKTREE_WORDS.hint}</span>
      {said && (
        <span className="settings__hint" role="status">
          {said}
        </span>
      )}
      {asked && confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          cancelLabel="Cancel"
          destructive
          onCancel={() => setAsked(null)}
          onConfirm={() => {
            const row = asked;
            setAsked(null);
            void onRemove({
              repo,
              path: row.path,
              discardDirty: confirm.discardDirty,
              ...(confirm.keepHeadAs && { keepHeadAs: confirm.keepHeadAs }),
            }).then((outcome) => {
              setSaid(unheldRemovalWords(outcome));
              setReads((n) => n + 1);
            });
          }}
        />
      )}
    </section>
  );
}
