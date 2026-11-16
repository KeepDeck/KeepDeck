import { useState, type ReactNode } from "react";
import type {
  RepoCheckout,
  UnheldRemoval,
  UnheldRemovalRequest,
  Workspace,
  WorkspacePatch,
  WorkspaceUpdateResult,
} from "../../domain/deck";
import {
  updateRefusalWords,
  WORKSPACES_WORDS,
  workspacesWindowView,
  type WorkspaceListGroup,
  type WorkspacePageView,
} from "../../presentation/workspacesWindowView";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { WorktreesSection } from "./WorktreesSection";

export interface WorkspacesDialogProps {
  workspaces: Workspace[];
  activeId: string;
  /** The workspace whose page is open, when one was picked or named. */
  focus: string | null;
  onFocus(wsId: string): void;
  onRestore(wsId: string): void;
  onArchive(wsId: string): void;
  onCloseWorkspace(wsId: string): void;
  /** Edit the page's workspace; the domain's answer comes back. */
  onUpdate(wsId: string, patch: WorkspacePatch): WorkspaceUpdateResult;
  pickFolder(title: string): Promise<string | null>;
  listWorktrees(repo: string): Promise<RepoCheckout[]>;
  onRemoveWorktree(request: UnheldRemovalRequest): Promise<UnheldRemoval>;
  /** The "+ Team" door, for the workspace whose page is open. */
  onNewTeam(wsId: string): void;
  onClose(): void;
  /** Whether the window may close itself now (no transaction over it). */
  canClose: boolean;
}

/**
 * The Workspaces window: every workspace — the ones in the strip and the
 * archived ones — on the left, the picked one's page on the right. Draws
 * what `workspacesWindowView` decides; the search is the only state it
 * keeps, and every act goes back to the flow that owns it.
 */
export function WorkspacesDialog({
  workspaces,
  activeId,
  focus,
  onFocus,
  onRestore,
  onArchive,
  onCloseWorkspace,
  onUpdate,
  pickFolder,
  listWorktrees,
  onRemoveWorktree,
  onNewTeam,
  onClose,
  canClose,
}: WorkspacesDialogProps) {
  const [query, setQuery] = useState("");
  useEscape(onClose, canClose);
  const view = workspacesWindowView({ workspaces, activeId, query, focus, now: Date.now() });
  return (
    <ModalOverlay>
      <div className="form settings workspaces" role="dialog" aria-modal="true" aria-label={WORKSPACES_WORDS.title}>
        <div className="settings__head">
          <h2 className="form__title settings__title">{WORKSPACES_WORDS.title}</h2>
          <CloseButton label={WORKSPACES_WORDS.close} onClick={onClose} autoFocus />
        </div>
        <div className="settings__body workspaces__body">
          <nav className="settings__nav workspaces__list" aria-label={WORKSPACES_WORDS.title}>
            <input
              className="form__input workspaces__search"
              type="search"
              placeholder={WORKSPACES_WORDS.search}
              aria-label={WORKSPACES_WORDS.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ListGroup group={view.inStrip} onPick={onFocus} />
            <ListGroup group={view.archived} onPick={onFocus} />
            {view.noMatch && <span className="settings__hint workspaces__none">{WORKSPACES_WORDS.noMatch}</span>}
          </nav>
          <section className="settings__section workspaces__page">
            {view.page && (
              <Page
                // A page per workspace: what one was being typed into is not
                // carried onto the next.
                key={view.page.id}
                page={view.page}
                onRestore={onRestore}
                onArchive={onArchive}
                onCloseWorkspace={onCloseWorkspace}
                onUpdate={onUpdate}
                pickFolder={pickFolder}
              >
                {(() => {
                  const ws = workspaces.find((candidate) => candidate.id === view.page?.id);
                  return ws ? (
                    <WorktreesSection
                      workspace={ws}
                      workspaces={workspaces}
                      listWorktrees={listWorktrees}
                      onRemove={onRemoveWorktree}
                      onNewTeam={ws.archived ? null : () => onNewTeam(ws.id)}
                    />
                  ) : null;
                })()}
              </Page>
            )}
          </section>
        </div>
      </div>
    </ModalOverlay>
  );
}

function ListGroup({ group, onPick }: { group: WorkspaceListGroup; onPick(wsId: string): void }) {
  return (
    <>
      <span className="workspaces__group">
        <span className="settings__nav-group-label">{group.label}</span>
        <span className="workspaces__group-count">{group.count}</span>
      </span>
      {group.rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={`workspaces__row${row.selected ? " workspaces__row--on" : ""}`}
          aria-current={row.selected || undefined}
          // The full name, where the row cuts it short.
          title={row.name}
          onClick={() => onPick(row.id)}
        >
          <span className={`workspaces__tile${row.active ? " workspaces__tile--active" : ""}`} aria-hidden>
            {row.initials}
          </span>
          <span className="workspaces__row-name">{row.name}</span>
          {row.meta !== null && <span className="workspaces__row-meta">{row.meta}</span>}
        </button>
      ))}
    </>
  );
}

function Page({
  page,
  onRestore,
  onArchive,
  onCloseWorkspace,
  onUpdate,
  pickFolder,
  children,
}: {
  children?: ReactNode;
  page: WorkspacePageView;
  onRestore(wsId: string): void;
  onArchive(wsId: string): void;
  onCloseWorkspace(wsId: string): void;
  onUpdate(wsId: string, patch: WorkspacePatch): WorkspaceUpdateResult;
  pickFolder(title: string): Promise<string | null>;
}) {
  const { state, acts, fields } = page;
  /** What the last edit was refused for, until the next one. */
  const [refusal, setRefusal] = useState<string | null>(null);
  const update = (patch: WorkspacePatch) => {
    const result = onUpdate(page.id, patch);
    setRefusal(result.ok ? null : updateRefusalWords(result.refusal));
  };
  const choose = (title: string, apply: (path: string) => WorkspacePatch) => {
    void pickFolder(title).then((path) => {
      if (path !== null) update(apply(path));
    });
  };
  return (
    <div className="workspaces__pane">
      <header className="workspaces__head">
        <span className="workspaces__tile workspaces__tile--big" aria-hidden>
          {page.initials}
        </span>
        <div className="workspaces__title">
          <h3>{page.name}</h3>
          <span className="workspaces__path" title={page.cwd}>
            {page.cwd}
          </span>
        </div>
        <span className="workspaces__facts">{page.facts}</span>
      </header>
      {state.kind !== "in-use" && (
        <div className="workspaces__banner" role="status">
          <span className="workspaces__banner-text">
            <b>{state.banner}</b> {WORKSPACES_WORDS.restoreNote}
            {state.kind === "archived" && state.owed && <span className="workspaces__owed">{state.owed}</span>}
          </span>
          <Button size="sm" variant="primary" onClick={() => onRestore(page.id)}>
            {WORKSPACES_WORDS.restore}
          </Button>
        </div>
      )}
      <section className="workspaces__sec">
        <h4>{WORKSPACES_WORDS.identity}</h4>
        <label className="workspaces__field">
          <span className="form__label">{WORKSPACES_WORDS.name}</span>
          <input
            // Re-seeded when the name changes elsewhere (the crumb, a command).
            key={fields.name}
            className="form__input"
            defaultValue={fields.name}
            readOnly={!fields.editable}
            aria-label={WORKSPACES_WORDS.name}
            onBlur={(event) => {
              if (fields.editable && event.currentTarget.value !== fields.name) update({ name: event.currentTarget.value });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label className="workspaces__field">
          <span className="form__label">{WORKSPACES_WORDS.mark}</span>
          <input
            key={fields.mark}
            className="form__input workspaces__letters"
            defaultValue={fields.mark}
            // What it says now when the person chose nothing.
            placeholder={page.initials}
            readOnly={!fields.editable}
            aria-label={WORKSPACES_WORDS.mark}
            onBlur={(event) => {
              if (fields.editable && event.currentTarget.value !== fields.mark) update({ mark: event.currentTarget.value });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="settings__hint">{WORKSPACES_WORDS.markHint}</span>
        </label>
      </section>
      <section className="workspaces__sec">
        <h4>{WORKSPACES_WORDS.folders}</h4>
        <div className="workspaces__field">
          <span className="form__label">{WORKSPACES_WORDS.workingDirectory}</span>
          <div className="form__dir">
            <span className="form__dir-path" title={fields.cwd.path}>
              <span>{fields.cwd.path}</span>
            </span>
            {fields.editable && !fields.cwd.locked && (
              <button
                type="button"
                className="form__dir-btn"
                aria-label={WORKSPACES_WORDS.chooseWorkingDirectory}
                onClick={() => choose(WORKSPACES_WORDS.chooseWorkingDirectory, (cwd) => ({ cwd }))}
              >
                {WORKSPACES_WORDS.choose}
              </button>
            )}
          </div>
          {fields.editable && fields.cwd.locked && <span className="settings__hint">{WORKSPACES_WORDS.cwdLocked}</span>}
        </div>
        <div className="workspaces__field">
          <span className="form__label">{WORKSPACES_WORDS.worktreeFolder}</span>
          <div className="form__dir">
            <span className={`form__dir-path${fields.worktreeBaseDir ? "" : " form__dir-path--empty"}`}>
              <span>{fields.worktreeBaseDir ?? WORKSPACES_WORDS.noWorktreeFolder}</span>
            </span>
            {fields.editable && (
              <>
                <button
                  type="button"
                  className="form__dir-btn"
                  aria-label={WORKSPACES_WORDS.chooseWorktreeFolder}
                  onClick={() =>
                    choose(WORKSPACES_WORDS.chooseWorktreeFolder, (worktreeBaseDir) => ({ worktreeBaseDir }))
                  }
                >
                  {WORKSPACES_WORDS.choose}
                </button>
                {fields.worktreeBaseDir !== null && (
                  <button type="button" className="form__dir-btn" onClick={() => update({ worktreeBaseDir: null })}>
                    {WORKSPACES_WORDS.clear}
                  </button>
                )}
              </>
            )}
          </div>
          <span className="settings__hint">{WORKSPACES_WORDS.worktreeFolderHint}</span>
        </div>
        {!fields.editable && <span className="settings__hint">{WORKSPACES_WORDS.readOnly}</span>}
        {refusal && (
          <span className="settings__hint settings__hint--warn" role="alert">
            {refusal}
          </span>
        )}
      </section>
      {children}
      <footer className="workspaces__foot">
        {acts.archive && (
          <Button variant="secondary" onClick={() => onArchive(page.id)}>
            {WORKSPACES_WORDS.archive}
          </Button>
        )}
        <button
          type="button"
          className="btn-destructive"
          disabled={acts.close.disabled}
          title={acts.close.refusal}
          onClick={() => onCloseWorkspace(page.id)}
        >
          {WORKSPACES_WORDS.closeWorkspace}
        </button>
        {acts.close.refusal && <span className="settings__hint workspaces__refusal">{acts.close.refusal}</span>}
      </footer>
    </div>
  );
}
