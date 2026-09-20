/**
 * The artifacts backend's last transition — the shared enable-status cell
 * ([`createEnableStatus`]) as this feature's one instance, beside
 * [`artifactChanges`]. `refusalOf` is re-exported so the registry's hook
 * keeps one import for both.
 */
import { createEnableStatus, type EnableStatus } from "../enableStatus";

export { refusalOf } from "../enableStatus";
export type ArtifactsEnableStatus = EnableStatus;

/** The app's one status. */
export const artifactsEnableStatus = createEnableStatus();
