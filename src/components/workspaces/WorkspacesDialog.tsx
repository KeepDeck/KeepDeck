import { useState } from "react";
import type { Workspace } from "../../domain/deck";
import {
  WORKSPACES_WORDS,
  workspacesWindowView,
  type WorkspaceListGroup,
  type WorkspacePageView,
} from "../../presentation/workspacesWindowView";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";

export interface WorkspacesDialogProps {
  workspaces: Workspace[];
  activeId: string;
  /** The workspace whose page is open, when one was picked or named. */
  focus: string | null;
  onFocus(wsId: string): void;
  onRestore(wsId: string): void;
  onArchive(wsId: string): void;
  onCloseWorkspace(wsId: string): void;
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
              <Page page={view.page} onRestore={onRestore} onArchive={onArchive} onCloseWorkspace={onCloseWorkspace} />
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
      <span className="settings__nav-group-label workspaces__group">{group.label}</span>
      {group.rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className={`workspaces__row${row.selected ? " workspaces__row--on" : ""}`}
          aria-current={row.selected || undefined}
          onClick={() => onPick(row.id)}
        >
          <span className="workspaces__tile" aria-hidden>
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
}: {
  page: WorkspacePageView;
  onRestore(wsId: string): void;
  onArchive(wsId: string): void;
  onCloseWorkspace(wsId: string): void;
}) {
  const { state, acts } = page;
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
