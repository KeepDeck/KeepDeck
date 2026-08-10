/**
 * The card a pane wears while the worktree behind it is being created.
 *
 * A status card instead of a terminal, and the reason is not cosmetic:
 * mounting a terminal now would spawn the agent into somebody else's
 * directory.
 */
import type { PaneProvisioning } from "../../../domain/deck";
import { LaunchSpinner } from "../../../ui/LaunchSpinner";

export function ProvisioningBody({
  provisioning,
  onRetry,
}: {
  provisioning: PaneProvisioning;
  onRetry?: () => void;
}) {
  if (provisioning.error) {
    return (
      <div className="pane__card" role="alert">
        <span className="pane__exit-title">Worktree failed</span>
        <span
          className="pane__exit-sub pane__card-path"
          title={provisioning.error}
        >
          {provisioning.error}
        </span>
        {onRetry && (
          <button type="button" className="pane__card-action" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="pane__card" role="status">
      <LaunchSpinner />
      <span className="pane__exit-title">
        {provisioning.phase === "setup"
          ? "Running setup…"
          : "Creating worktree…"}
      </span>
      <ProvisionLocation provisioning={provisioning} />
    </div>
  );
}

/** The creating card's location line: "branch · path" from what the intent
 * knows (the batch flow auto-names its branch on the Rust side, so it may
 * only have the base folder). */
function ProvisionLocation({
  provisioning,
}: {
  provisioning: PaneProvisioning;
}) {
  const location = [provisioning.branch, provisioning.path ?? provisioning.baseDir]
    .filter(Boolean)
    .join(" · ");
  if (!location) return null;
  return (
    <span className="pane__exit-sub pane__card-path" title={location}>
      {location}
    </span>
  );
}
