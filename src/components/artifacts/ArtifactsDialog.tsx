import type { ArtifactsRegistryReadPort } from "../../app/artifacts/registryRead";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { artifactRowView } from "../../presentation/artifacts/rowView";
import { deleteQuestion } from "../../presentation/artifacts/words";
import { useArtifactsRegistry } from "./useArtifactsRegistry";
import {
  ARTIFACT_ROW_ESTIMATE_PX,
  artifactRowKey,
  placeholderView,
  type PlaceholderView,
} from "../../presentation/artifacts/view";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";

interface ArtifactsDialogProps {
  /** The workspace whose artifacts these are; `null` when no workspace is
   * open — the store is workspace-scoped, so there is nothing to list. */
  activeWs: { id: string; name: string } | null;
  /** The store as this surface may read it — bound once at the composition
   * root and handed down as the same object. */
  reads: ArtifactsRegistryReadPort;
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
  reads,
  onClose,
  canClose = true,
}: ArtifactsDialogProps) {
  const registry = useArtifactsRegistry(activeWs?.id ?? null, reads);
  const { view, busyId, confirm, expanded, query } = registry;
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
  // A workspace's artifacts have no ceiling — an agent publishes as many
  // as the work needs, and nothing prunes them — so the list is windowed
  // like the sessions browser's, on the app's one list (below). Measured,
  // not assumed: an item is a row plus, when it is the open one, its whole
  // version history — heights differ by an order of magnitude within one
  // list. A row scrolled out of the window is UNMOUNTED, and focus inside
  // it goes with it — accepted, deliberately, rather than carried to a
  // neighbour the way the sessions browser carries it: the modal's
  // background is `inert`, so the keyboard cannot fall past the dialog,
  // and the next Tab resumes at its first control.

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

        {/* The search box stands whenever a list could be searched —
            including when the query emptied it, which is exactly when
            the user needs it back to change what they typed. */}
        {(view.kind === "rows" || view.kind === "noMatch") && (
          <input
            className="artifacts__search"
            value={query}
            placeholder="Search this workspace — titles and ids"
            aria-label="Search artifacts"
            onChange={(e) => registry.search(e.target.value)}
          />
        )}

        <p className="artifacts__hint">
          A published page is served on a port that changes every time
          KeepDeck starts, so an old link stops answering. Open one from
          here — the address is resolved on the spot.
        </p>

        {(view.kind === "rows" || view.kind === "noMatch") &&
          view.banner !== null && (
          <p className="artifacts__error kd-selectable" role="alert">
            {view.banner}
          </p>
        )}

        {view.kind !== "rows" ? (
          <div className="artifacts__body">
            <Placeholder view={placeholderView(view)} />
          </div>
        ) : (
          // The body IS the windowed list: the scroll container, a ul
          // spacer the measured height of every row, and only the rows in
          // view mounted as li items — the list stays ONE ul/li list.
          <VirtualList
            items={view.rows}
            itemKey={artifactRowKey}
            estimate={ARTIFACT_ROW_ESTIMATE_PX}
            className="artifacts__body"
            spacer={{ as: "ul", className: "artifacts__list" }}
            item={{ as: "li", className: "artifacts__item" }}
            render={(row) => {
              const item = artifactRowView(row, now, busyId, expanded);
              return (
                // ONE measured box per artifact: the row, and the history
                // when this is the open one. They are one item because
                // they move together and are measured together — the
                // history is what makes an item's height differ from its
                // neighbours' by an order of magnitude.
                <>
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
                    aria-label={item.openLabel}
                    disabled={item.busy}
                    onClick={() => registry.open(row.id)}
                  >
                    <span className="artifacts__row-title">{item.title}</span>
                    <span className="artifacts__row-meta">
                      <code>{item.id}</code>
                      {item.tail}
                    </span>
                  </button>
                  <div className="artifacts__row-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => registry.toggleVersions(row.id)}
                    >
                      {item.toggleLabel}
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
                      aria-label={item.deleteLabel}
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
                {item.history !== null && (
                  <div className="artifacts__history">
                    {item.history.kind === "note" ? (
                      <span className="artifacts__history-note">
                        {item.history.text}
                      </span>
                    ) : (
                      item.history.lines.map((line) => (
                        <div key={line.n} className="artifacts__version">
                          <span className="artifacts__version-n">
                            {line.label}
                          </span>
                          <span className="artifacts__version-when">
                            {line.when}
                          </span>
                          {line.message !== null && (
                            <span className="artifacts__version-message">
                              {line.message}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
                </>
              );
            }}
          />
        )}
      </div>

      {confirm !== null && (
        <ConfirmDialog
          title="Delete artifact"
          message={deleteQuestion(confirm.title)}
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

/** The body's one seat for the text states — loading, empty, no match,
 * no workspace, a store's refusal — drawn from their view. */
function Placeholder({ view }: { view: PlaceholderView }) {
  return (
    <div className="artifacts__placeholder">
      {view.title !== null && (
        <span className={view.title.className} role={view.title.role}>
          {view.title.text}
        </span>
      )}
      {view.detail !== null && <span>{view.detail}</span>}
    </div>
  );
}
