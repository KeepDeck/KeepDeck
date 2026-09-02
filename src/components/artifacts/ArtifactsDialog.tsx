import { formatAge } from "../../domain/usage";
import { Button } from "../../ui/Button";
import { CloseButton } from "../../ui/CloseButton";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";
import { useWallClock } from "../../ui/useWallClock";
import { useArtifactsRegistry } from "./useArtifactsRegistry";

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
 * identity, so this surface hands out identities (copy the id) and
 * resolves one into a live url only at the moment it is opened.
 *
 * The SHELL: chrome, the placeholder ladder, the rows. Every transition
 * belongs to `useArtifactsRegistry`.
 */
export function ArtifactsDialog({
  activeWs,
  onClose,
  canClose = true,
}: ArtifactsDialogProps) {
  useEscape(onClose, canClose);
  const registry = useArtifactsRegistry(activeWs?.id ?? null);
  const { rows, error, busyId, copiedId } = registry;
  // The rows are sorted newest-first by the store, so the head row is the
  // clock's floor: a publish seconds after the last tick must not render
  // as an age in the future.
  const now = useWallClock(rows?.[0]?.updatedAt ?? 0);

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

        {error !== null && (rows?.length ?? 0) > 0 && (
          <p className="artifacts__error kd-selectable" role="alert">
            {error}
          </p>
        )}

        <div className="artifacts__body">
          {activeWs === null ? (
            <div className="artifacts__placeholder">
              <span className="artifacts__placeholder-title">
                No workspace open
              </span>
              <span>Artifacts belong to a workspace — open one first</span>
            </div>
          ) : rows === null ? (
            <div className="artifacts__placeholder">Loading…</div>
          ) : error !== null && rows.length === 0 ? (
            // A store that REFUSED renders as itself, never as a workspace
            // that has published nothing.
            <div className="artifacts__placeholder">
              <span
                className="artifacts__placeholder-title kd-selectable"
                role="alert"
              >
                {error}
              </span>
            </div>
          ) : rows.length === 0 ? (
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
            <ul className="artifacts__list">
              {rows.map((row) => (
                <li key={row.id} className="artifacts__row">
                  {/* The row IS the control — a list row is one of the
                      archetypes the shared Button deliberately does not
                      cover, so it is spelled here. Copy id stays a real
                      button beside it rather than inside it: nesting one
                      button in another is invalid, and the two answer
                      different questions anyway. */}
                  <button
                    type="button"
                    className="artifacts__row-open"
                    aria-label={`Open ${row.title}`}
                    disabled={busyId === row.id}
                    onClick={() => registry.open(row.id)}
                  >
                    <span className="artifacts__row-title">{row.title}</span>
                    <span className="artifacts__row-meta">
                      <code>{row.id}</code>
                      {` · v${row.versionCount} · ${formatAge(
                        row.updatedAt,
                        now,
                      )}`}
                      {row.lastAuthor === "" ? "" : ` · ${row.lastAuthor}`}
                    </span>
                  </button>
                  <div className="artifacts__row-actions">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => registry.copyId(row.id)}
                    >
                      {copiedId === row.id ? "Copied" : "Copy id"}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
