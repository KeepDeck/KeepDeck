import { useEffect, useState } from "react";
import type { RepoCheckout, UnheldRemovalRequest, Workspace } from "../../domain/deck";
import type { Claim, IntentOutcome } from "../../domain/lifecycle";
import {
  unheldRemovalWords,
  WORKTREE_WORDS,
  worktreeRemovalConfirm,
  worktreeTableView,
} from "../../presentation/worktreeTableView";
import { GitBranchIcon } from "@keepdeck/ui-kit/icons";
import { Chip } from "@keepdeck/ui-kit/Chip";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";

export interface WorktreesSectionProps {
  workspace: Workspace;
  workspaces: readonly Workspace[];
  listWorktrees(repo: string): Promise<RepoCheckout[]>;
  /** What the lifecycle says holds a folder. */
  claimsOn(path: string): Promise<Claim[]>;
  onRemove(request: UnheldRemovalRequest): Promise<IntentOutcome>;
  /** Make a new team in a worktree of its own — the "+ Team" door. Null
   * while the workspace cannot take one (archived). */
  onNewTeam: (() => void) | null;
  /** Open the team a checkout belongs to. */
  onOpenTeam(wsId: string, teamId: string): void;
}

/**
 * The page's Worktrees: every checkout of the workspace's repository, who
 * holds it, what is in it — and Remove for one nobody holds, behind a
 * confirm that says what goes and what stays. Reads the list when the page
 * opens and again after a removal; decides nothing it can hand to the view.
 */
export function WorktreesSection({
  workspace,
  workspaces,
  listWorktrees,
  claimsOn,
  onRemove,
  onNewTeam,
  onOpenTeam,
}: WorktreesSectionProps) {
  const [listed, setListed] = useState<RepoCheckout[] | "loading" | "none">("loading");
  const [claims, setClaims] = useState<ReadonlyMap<string, Claim[] | null>>(new Map());
  const [reads, setReads] = useState(0);
  /** The row asked about, and when — the moment its kept-commit tag names. */
  const [asked, setAsked] = useState<{ row: RepoCheckout; at: number } | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const repo = workspace.cwd;

  // The list, then the machine's claims on each row, read together: a row
  // never shows as free for want of its claims. Claims that cannot be read
  // stay unknown, and such a row is not offered for removal.
  useEffect(() => {
    let current = true;
    listWorktrees(repo)
      .then(async (rows) => {
        const held = await Promise.all(rows.map((row) => claimsOn(row.path).catch((): Claim[] | null => null)));
        if (!current) return;
        setClaims(new Map(rows.map((row, at) => [row.path, held[at]])));
        setListed(rows);
      })
      .catch(() => current && setListed("none"));
    return () => {
      current = false;
    };
  }, [listWorktrees, claimsOn, repo, reads]);

  const table = Array.isArray(listed) ? worktreeTableView(listed, (path) => claims.get(path) ?? null, workspace, workspaces) : null;
  const confirm = asked ? worktreeRemovalConfirm(asked.row, workspace, asked.at) : null;

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
        <table className="worktrees">
          <thead>
            <tr>
              <th>{WORKTREE_WORDS.columns.folder}</th>
              <th>{WORKTREE_WORDS.columns.branch}</th>
              <th>{WORKTREE_WORDS.columns.holder}</th>
              <th>{WORKTREE_WORDS.columns.state}</th>
              {table.acts && <th className="worktrees__acts-col" />}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, at) => (
              <tr key={row.path} className={row.holderKind === "free" ? "worktrees__row--free" : undefined}>
                <td className="worktrees__folder" title={row.path}>
                  {row.folder}
                </td>
                <td title={row.branch}>
                  <span className={`worktrees__branch${row.detached ? " worktrees__branch--detached" : ""}`}>
                    {!row.detached && <GitBranchIcon />}
                    {row.branch}
                  </span>
                </td>
                <td className={`worktrees__holder worktrees__holder--${row.holderKind}`} title={row.holder}>
                  {row.holder}
                </td>
                <td>
                  {row.stateKind === "changed" ? (
                    <Chip size="inline" tone="warn" label={row.state} />
                  ) : (
                    <span className="worktrees__quiet">{row.state}</span>
                  )}
                </td>
                {table.acts && (
                  <td className="worktrees__act">
                    {row.team && (
                      <Button size="sm" variant="ghost" onClick={() => row.team && onOpenTeam(row.team.wsId, row.team.teamId)}>
                        {WORKTREE_WORDS.openTeam}
                      </Button>
                    )}
                    {row.removable && Array.isArray(listed) && (
                      <Button size="sm" variant="ghost" onClick={() => setAsked({ row: listed[at], at: Date.now() })}>
                        {WORKTREE_WORDS.remove}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {table?.removable && <span className="settings__hint">{WORKTREE_WORDS.hint}</span>}
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
            const { row } = asked;
            const keepHeadAs = confirm.keepHeadAs;
            setAsked(null);
            void onRemove({ path: row.path, ...(keepHeadAs && { keepHeadAs }) }).then((outcome) => {
              setSaid(unheldRemovalWords(outcome, keepHeadAs));
              setReads((n) => n + 1);
            });
          }}
        />
      )}
    </section>
  );
}
