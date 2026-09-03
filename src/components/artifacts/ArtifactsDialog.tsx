import { useRef } from "react";
import { formatAge } from "../../domain/usage";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { rowMeta, versionsNewestFirst } from "./rowMeta";
import { useArtifactsRegistry } from "./useArtifactsRegistry";
import { useRowWindow } from "./useRowWindow";

/** One array identity for every non-list state: a fresh `[]` per render
 * would give the window a new input each time and re-key its memos. */
const EMPTY: readonly ArtifactMetaRow[] = [];

interface ArtifactsDialogProps {
  /** The workspace whose artifacts these are; `null` when no workspace is
   * open — the store is workspace-scoped, so there is nothing to list. */
  activeWs: { id: string; name: string } | null;
  onClose(): void;
  /** False while a transaction is stacked over this dialog: `onClose`
   * refuses then, so Escape must not be claimed either. */
  canClose?: boolean;
}

/**
 * The artifacts registry — the app-side door to what agents published.
 *
 * It exists because an artifact's URL is mortal by construction: the
 * display server takes a fresh port every launch, so a link that left
 * this app answers nothing after a restart. What survives is the
 * identity, so this surface keeps the identities and resolves one into
 * a live url only at the moment a row is opened.
 *
 * The SHELL: chrome, the placeholder ladder, the rows. Every transition
 * belongs to `useArtifactsRegistry`.
 */
export function ArtifactsDialog({
  activeWs,
  onClose,
  canClose = true,
}: ArtifactsDialogProps) {
  const registry = useArtifactsRegistry(activeWs?.id ?? null);
  const { view, busyId, confirm, expanded } = registry;
  // Escape belongs to the confirm while one is stacked over this dialog:
  // the handlers stack, so a single press would answer the question AND
  // close the surface underneath it. `canClose` is the caller's half of
  // the same rule, for a transaction stacked over the whole app.
  useEscape(onClose, canClose && confirm === null);
  // The rows are sorted newest-first by the store, so the head row is the
  // clock's floor: a publish seconds after the last tick must not render
  // as an age in the future.
  const now = useWallClock(
    view.kind === "rows" ? (view.rows[0]?.updatedAt ?? 0) : 0,
  );
  // The body is the scroll container the window measures against.
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowWindow = useRowWindow(view.kind === "rows" ? view.rows : EMPTY, bodyRef);

  return (
    <ModalOverlay>
      <div
        className="form artifacts"
        role="dialog"
        aria-modal="true"
        aria-label="Artifacts"
      >
        <div className="artifacts__head">
          <h2 className="form__title artifacts__title">Artifacts</h2>
          <CloseButton label="Close artifacts" onClick={onClose} autoFocus />
        </div>

        <p className="artifacts__hint">
          A published page is served on a port that changes every time
          KeepDeck starts, so an old link stops answering. Open one from
          here — the address is resolved on the spot.
        </p>

        {view.kind === "rows" && view.banner !== null && (
          <p className="artifacts__error kd-selectable" role="alert">
            {view.banner}
          </p>
        )}

        <div className="artifacts__body" ref={bodyRef}>
          {view.kind === "noWorkspace" ? (
            <div className="artifacts__placeholder">
              <span className="artifacts__placeholder-title">
                No workspace open
              </span>
              <span>Artifacts belong to a workspace — open one first</span>
            </div>
          ) : view.kind === "loading" ? (
            <div className="artifacts__placeholder">Loading…</div>
          ) : view.kind === "refusal" ? (
            <div className="artifacts__placeholder">
              <span
                className="artifacts__placeholder-title kd-selectable"
                role="alert"
              >
                {view.message}
              </span>
            </div>
          ) : view.kind === "empty" ? (
            <div className="artifacts__placeholder">
              <span className="artifacts__placeholder-title">
                Nothing published yet
              </span>
              <span>
                Agents publish pages here; they open in your browser and
                refresh themselves as the agent iterates
              </span>
            </div>
          ) : (
            // The spacer: the measured height of every row, with the
            // window's items absolutely positioned inside it. The list
            // stays ONE ul/li list and the scroll container stays the
            // body above.
            <ul
              className="artifacts__list"
              style={{ height: `${rowWindow.totalSize}px`, position: "relative" }}
            >
              {rowWindow.items.map((item) => {
                const row = view.rows[item.index];
                const meta = rowMeta(row, now);
                return (
                // ONE measured box per artifact: the row, and the history
                // when this is the open one. They are one item because
                // they move together and are measured together — the
                // history is what makes an item's height differ from its
                // neighbours' by an order of magnitude.
                <li
                  key={item.key}
                  ref={rowWindow.measure}
                  data-index={item.index}
                  className="artifacts__item"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                <div className="artifacts__row">
                  {/* The row IS the control — a list row is one of the
                      archetypes the shared Button deliberately does not
                      cover, so it is spelled here. The actions beside it
                      stay OUTSIDE it: a button within a button is invalid
                      markup, and a press meant for one would carry into
                      the other. */}
                  <button
                    type="button"
                    className="artifacts__row-open"
                    aria-label={`Open ${row.title}`}
                    disabled={busyId === row.id}
                    onClick={() => registry.open(row.id)}
                  >
                    <span className="artifacts__row-title">{row.title}</span>
                    <span className="artifacts__row-meta">
                      <code>{meta.id}</code>
                      {meta.tail}
                    </span>
                  </button>
                  <div className="artifacts__row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => registry.toggleVersions(row.id)}
                    >
                      {expanded?.id === row.id ? "Hide history" : "History"}
                    </Button>
                    {/* The row-level delete idiom — a small text ×, the
                        one the workspaces rail and the journal rows use.
                        The header's shared close glyph means "close this
                        surface" and must not come to mean "destroy this
                        thing". */}
                    <button
                      type="button"
                      className="artifacts__remove"
                      title="Delete artifact"
                      aria-label={`Delete ${row.title}`}
                      onClick={() => registry.requestDelete(row.id)}
                    >
                      ×
                    </button>
                  </div>
                </div>
                {/* The history sits UNDER its row and outside the row's
                    control, never inside it: a list of versions within a
                    button is the nesting the delete × already avoids.
                    Drawn whole rather than windowed in its own right —
                    one history is open at a time and they run to tens.
                    If one ever reaches the scale the LIST is windowed
                    for, it wants the same treatment. */}
                {expanded?.id === row.id && (
                  <div className="artifacts__history">
                    {expanded.versions === null ? (
                      <span className="artifacts__history-note">Loading…</span>
                    ) : expanded.versions.length === 0 ? (
                      <span className="artifacts__history-note">
                        No versions — the artifact went while this opened
                      </span>
                    ) : (
                      versionsNewestFirst(expanded.versions).map((version) => (
                        <div key={version.n} className="artifacts__version">
                          <span className="artifacts__version-n">
                            v{version.n}
                          </span>
                          <span className="artifacts__version-when">
                            {formatAge(version.at, now)}
                          </span>
                          <span className="artifacts__version-author">
                            {version.authorLabel}
                          </span>
                          {version.message !== undefined && (
                            <span className="artifacts__version-message">
                              {version.message}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
                </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {confirm !== null && (
        <ConfirmDialog
          title="Delete artifact"
          message={`Delete "${confirm.title}"? Every version goes, its open pages say goodbye, and the id stops resolving`}
          confirmLabel="Delete"
          cancelLabel="Cancel"
          destructive
          onConfirm={registry.confirmDelete}
          onCancel={registry.cancelConfirm}
        />
      )}
    </ModalOverlay>
  );
}
